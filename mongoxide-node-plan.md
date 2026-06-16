# mongoxide-node — Claude Code Build Plan

You are building a Rust-native MongoDB driver for Node.js that replaces Mongoose for read operations.
The goal is 20-30x faster reads than Mongoose by doing BSON parsing off the Node.js main thread
using Rust worker threads, parallel batch fetching, and lazy zero-copy deserialization.

This plan is structured as sequential phases. Complete each phase fully before starting the next.
After each phase, run the tests and confirm they pass before proceeding.

---

## Context — what you are building and why

The official Node.js MongoDB driver deserializes all BSON bytes eagerly on the main thread.
Mongoose adds another full pass of hydration on top of that.
Together they block the Node.js event loop for every batch of documents returned.

This Rust driver does three things differently:
1. BSON parsing happens on Rust worker threads (rayon), never on the Node.js event loop
2. Batch fetching is pipelined — while batch 1 is being parsed, batch 2 is already being fetched
3. Deserialization is lazy — fields are only converted to JS values when your code actually reads them

The MongoDB Rust driver (official, by MongoDB) handles all wire protocol, connection pooling,
auth, TLS, and replica set failover. You are building the Node.js integration layer on top of it.

---

## Tech stack

- Rust (edition 2021)
- napi-rs v2 — Node.js native addon framework
- mongodb crate v3.5+ — official MongoDB Rust driver (use RawBatchCursor API)
- tokio — async runtime for concurrent batch fetching
- rayon — thread pool for CPU-bound BSON parsing
- bson crate — BSON types and raw document access
- TypeScript — public API layer and type definitions

---

## Project structure to create

```
mongoxide-node/
├── Cargo.toml
├── package.json
├── build.rs
├── src/
│   ├── lib.rs              — napi-rs exports, public API surface
│   ├── client.rs           — MongoClient wrapper, connection management
│   ├── collection.rs       — Collection, find(), aggregate()
│   ├── cursor.rs           — Streaming pipeline: fetch + parse + backpressure
│   ├── deserialize.rs      — Lazy BSON → JS conversion
│   ├── schema.rs           — Schema definition, projection builder
│   └── error.rs            — Error types
├── ts/
│   ├── index.ts            — TypeScript public API
│   ├── model.ts            — Model base class (Mongoose-like ergonomics)
│   └── types.ts            — TypeScript type definitions
├── tests/
│   ├── parity/             — Tests proving behavior matches official driver
│   │   ├── find.test.ts
│   │   ├── projection.test.ts
│   │   ├── sort.test.ts
│   │   ├── skip_limit.test.ts
│   │   └── types.test.ts
│   └── bench/
│       ├── find_bench.ts   — Benchmark vs official driver
│       └── model_bench.ts  — Benchmark vs Mongoose
└── __tests__/
    └── integration/
        └── basic.test.ts
```

---

## Phase 1 — Project scaffold and basic connectivity

### Goal
Get a working napi-rs project that can connect to MongoDB and return raw documents.
No performance optimizations yet. Just prove the stack works end to end.

### Tasks

1. Initialize napi-rs project
```bash
npm install -g @napi-rs/cli
napi new mongoxide-node --targets x86_64-unknown-linux-gnu
cd mongoxide-node
```

2. Set up Cargo.toml with these exact dependencies
```toml
[package]
name = "mongoxide-node"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = { version = "2", features = ["async", "napi4"] }
napi-derive = "2"
mongodb = { version = "3.5", features = ["tokio-runtime"] }
tokio = { version = "1", features = ["full"] }
rayon = "1"
bson = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
once_cell = "1"

[build-dependencies]
napi-build = "2"
```

3. Implement a global tokio runtime in lib.rs
The tokio runtime must be initialized once and reused across all calls.
Use once_cell::sync::Lazy for this.
Do not create a new runtime per call — this is a common mistake that causes slowness.

4. Implement client.rs
Expose a connect(uri: String) function via napi that returns a client handle.
Store the mongodb::Client in a thread-safe wrapper (Arc<Mutex<Client>> or Arc<Client>).
Client is cheaply cloneable — Arc<Client> is preferred over Mutex.

5. Implement basic find() in collection.rs
Accept: database name, collection name, filter as JSON string, options as JSON string.
Parse filter JSON into a bson::Document.
Run the find using the standard cursor (not RawBatchCursor yet — that comes in Phase 3).
Deserialize results into Vec<String> where each string is a JSON-serialized document.
Return the Vec<String> to Node.js via napi.

6. Write TypeScript wrapper in ts/index.ts
```typescript
import { connect, find } from '../index'

export class MongoClient {
  private handle: any

  async connect(uri: string) {
    this.handle = await connect(uri)
    return this
  }

  collection(db: string, name: string): Collection {
    return new Collection(this.handle, db, name)
  }
}

export class Collection {
  constructor(
    private handle: any,
    private db: string,
    private name: string
  ) {}

  async find(filter: object = {}, options: object = {}): Promise<any[]> {
    const results = await find(this.handle, this.db, this.name,
      JSON.stringify(filter), JSON.stringify(options))
    return results.map((r: string) => JSON.parse(r))
  }
}
```

7. Write a basic integration test
Connect to a local MongoDB instance.
Insert 10 documents.
Call find() with a filter.
Assert correct documents returned.
Assert count matches.

### Phase 1 done when
- `cargo build` succeeds with no warnings
- `npm run build` produces a .node file
- Basic integration test passes against a real MongoDB instance
- find() returns correct documents as JavaScript objects

---

## Phase 2 — Parallel batch fetching with tokio

### Goal
Replace the sequential batch fetching with a pipelined approach.
While batch N is being processed, batch N+1 is already being fetched from MongoDB.
This alone gives 30-40% speedup on large result sets before any BSON optimization.

### How it works
Use tokio channels to decouple fetching from processing.
The fetcher task runs independently, continuously asking MongoDB for the next batch
and sending raw bytes down a channel.
The consumer reads from the channel at whatever pace it can.
A semaphore limits how many batches can be in-flight to bound memory usage.

### Tasks

1. Implement cursor.rs with a streaming pipeline

```rust
use tokio::sync::{mpsc, Semaphore};
use std::sync::Arc;

pub struct BatchPipeline {
    receiver: mpsc::Receiver<Vec<Vec<u8>>>,  // channel of raw BSON byte batches
}

impl BatchPipeline {
    pub async fn new(
        mut cursor: mongodb::Cursor<bson::RawDocumentBuf>,
        max_inflight_batches: usize,  // backpressure limit, use 4 as default
    ) -> Self {
        let semaphore = Arc::new(Semaphore::new(max_inflight_batches));
        let (sender, receiver) = mpsc::channel(max_inflight_batches);

        tokio::spawn(async move {
            while let Some(batch) = cursor.next_batch().await {
                let permit = semaphore.clone().acquire_owned().await.unwrap();
                let batch_bytes = extract_raw_bytes(batch);
                if sender.send(batch_bytes).await.is_err() {
                    break;  // consumer dropped, stop fetching
                }
                // permit dropped when consumer reads from channel
                drop(permit);
            }
        });

        Self { receiver }
    }

    pub async fn next_batch(&mut self) -> Option<Vec<Vec<u8>>> {
        self.receiver.recv().await
    }
}
```

2. Switch collection.rs find() to use BatchPipeline instead of sequential cursor iteration

3. Add batch_size option support — default 1000, configurable per query

4. Write a benchmark that measures time to fetch 10,000 documents
Compare sequential (Phase 1 implementation) vs pipelined (Phase 2 implementation)
Log the difference. Expect 30-40% improvement on large result sets.

5. Ensure backpressure works correctly
Write a test that fetches 10,000 documents but reads them slowly (add artificial delay)
Assert that memory usage stays bounded (not all 10,000 held in memory at once)

### Phase 2 done when
- Pipeline benchmark shows measurable improvement over sequential on 10,000+ docs
- Backpressure test passes — slow consumer does not cause unbounded memory growth
- All Phase 1 tests still pass

---

## Phase 3 — Off-thread BSON parsing with rayon

### Goal
Move all BSON deserialization off the Node.js main thread onto rayon worker threads.
This is the change that eliminates event loop blocking.
Use RawBatchCursor from the MongoDB Rust driver to get raw bytes before deserialization.

### How it works
RawBatchCursor gives you raw BSON bytes per batch without deserializing anything.
You pass those bytes to rayon::spawn which parses them on a CPU thread pool.
The Node.js event loop is free the entire time.

### Tasks

1. Switch to RawBatchCursor in collection.rs
```rust
// Before (Phase 1/2) — deserializes eagerly
let cursor = collection.find(filter).await?;

// After (Phase 3) — raw bytes, no deserialization
let cursor = collection.find_raw(filter).await?;
// Returns mongodb::action::FindCursor<RawDocumentBuf>
// Each batch is raw BSON bytes you control
```

2. Implement off-thread parsing in deserialize.rs
```rust
use rayon::prelude::*;

pub fn parse_batch_offthread(raw_bytes: Vec<Vec<u8>>) -> Vec<bson::Document> {
    // rayon par_iter automatically distributes across CPU threads
    raw_bytes
        .par_iter()
        .map(|doc_bytes| {
            bson::from_slice(doc_bytes).expect("valid BSON")
        })
        .collect()
}
```

3. Wire rayon parsing into the BatchPipeline from Phase 2
After each batch arrives from the tokio fetcher channel,
spawn a rayon task to parse it,
send parsed results to a second channel that Node.js reads from.

The pipeline now has three stages running concurrently:
- Stage 1 (tokio): fetch raw bytes from MongoDB
- Stage 2 (rayon): parse raw bytes into documents
- Stage 3 (Node.js): consume parsed documents

4. Measure event loop lag before and after
Use a setInterval(fn, 10) running alongside a heavy find() query.
Before Phase 3: interval fires late during BSON parsing (event loop blocked)
After Phase 3: interval fires on time (event loop free)
This is your proof that it works.

5. Write the parity test suite — this is critical for production safety
For each behavior below, write a test that runs the same query against both
the official mongodb Node.js driver and your Rust driver, and asserts identical results.

Behaviors to test:
- Basic find with filter
- find with projection (include fields)
- find with projection (exclude fields)
- find with sort ascending
- find with sort descending
- find with limit
- find with skip
- find with skip + limit combined
- find with nested field filter
- find with $gt, $lt, $gte, $lte operators
- find with $in operator
- find with $and operator
- find with $or operator
- find with no results (empty array returned)
- find with ObjectId filter
- find with Date field — assert dates are equal
- find with nested document — assert deep equality
- find with array field — assert array contents match
- find with null field value
- find with boolean field
- find with integer field
- find with float field
- find with very large result set (10,000 docs)
- find where cursor is abandoned midway (no memory leak)

Test structure for each:
```typescript
it('find with sort descending', async () => {
  const docs = [{ i: 1 }, { i: 2 }, { i: 3 }]
  await officialColl.insertMany(docs)

  const options = { sort: { i: -1 } }
  const official = await officialColl.find({}, options).toArray()
  const rust = await rustColl.find({}, options)

  expect(rust).toHaveLength(official.length)
  expect(rust[0].i).toBe(official[0].i)
  expect(rust[1].i).toBe(official[1].i)
  expect(rust[2].i).toBe(official[2].i)
})
```

### Phase 3 done when
- Event loop lag test confirms event loop is free during BSON parsing
- All 23 parity tests pass
- Benchmark shows 2-3x improvement over Phase 1 on medium-large result sets
- No memory leaks when cursor is abandoned midway

---

## Phase 4 — Lazy zero-copy deserialization

### Goal
Instead of converting BSON bytes to JavaScript objects immediately,
hold the raw bytes and only convert a field when JavaScript actually reads it.
If your code only reads doc.name from a 40-field document, only name is ever parsed.

This is the change that delivers the 20x improvement over Mongoose.

### How it works
Return a JavaScript Proxy object that intercepts property access.
When JS code reads doc.name, the proxy calls into Rust to parse just that field from raw bytes.
Fields never accessed are never parsed. Memory for the raw buffer is freed when the doc is GC'd.

### Tasks

1. Implement RawDoc in Rust — a struct that holds raw BSON bytes for one document
```rust
#[napi]
pub struct RawDoc {
    raw: Vec<u8>,  // the raw BSON bytes for this document
}

#[napi]
impl RawDoc {
    #[napi]
    pub fn get_field(&self, field_name: String) -> napi::Result<napi::JsUnknown> {
        // parse only the requested field from self.raw
        // use bson::RawDocument to navigate bytes without full parse
        let raw_doc = bson::RawDocument::from_bytes(&self.raw)?;
        match raw_doc.get(&field_name)? {
            Some(val) => bson_to_js(val),
            None => Ok(js_undefined()),
        }
    }

    #[napi]
    pub fn to_object(&self) -> napi::Result<napi::JsObject> {
        // full parse — called when user does spread or JSON.stringify
        let doc: bson::Document = bson::from_slice(&self.raw)?;
        document_to_js_object(doc)
    }

    #[napi]
    pub fn keys(&self) -> napi::Result<Vec<String>> {
        // return field names without parsing values
        let raw_doc = bson::RawDocument::from_bytes(&self.raw)?;
        Ok(raw_doc.iter().map(|(k, _)| k.to_string()).collect())
    }
}
```

2. Implement bson_to_js() — converts a single bson::RawBsonRef to a JS value
Handle all BSON types:
- String → JsString
- Int32, Int64 → JsNumber
- Double → JsNumber
- Boolean → JsBoolean
- DateTime → JsDate
- ObjectId → JsString (hex string)
- Document → nested RawDoc (lazy recursion)
- Array → JsArray of lazy values
- Null → JsNull
- Binary → JsBuffer

3. Create JavaScript Proxy wrapper in ts/index.ts
```typescript
function wrapRawDoc(rustDoc: any): any {
  return new Proxy(rustDoc, {
    get(target, prop: string) {
      if (prop === 'toJSON' || prop === 'toString') {
        return () => target.toObject()
      }
      if (prop === '__isRawDoc') return true
      return target.getField(prop)
    },
    has(target, prop: string) {
      return target.keys().includes(prop)
    },
    ownKeys(target) {
      return target.keys()
    }
  })
}
```

4. Update Collection.find() to return wrapped RawDoc proxies instead of plain objects

5. Add escape hatch for when full object is needed
```typescript
// User can always get plain object
const doc = await coll.find({ name: 'John' })
const plain = doc[0].toObject()  // full parse, returns plain JS object
```

6. Write lazy deserialization tests
- Assert that accessing doc.name does not parse doc.email
- Assert that a 40-field document where only 2 fields are read
  is faster than one where all 40 fields are read (proportional to fields accessed)
- Assert that toObject() returns identical result to official driver document

### Phase 4 done when
- Accessing one field on a 40-field document is measurably faster than accessing all 40
- All Phase 3 parity tests still pass with lazy docs
- toObject() passes all parity tests
- Proxy behavior is transparent — existing code that spreads or JSON.stringifies still works

---

## Phase 5 — Schema-based Model API (Mongoose replacement)

### Goal
Build a Model class that matches Mongoose ergonomics so existing code
can switch with minimal changes. Use the schema to automatically build
projections so MongoDB only sends the fields you defined in your model.

### Tasks

1. Implement schema parsing in schema.rs
Accept field definitions as a JSON string from TypeScript.
Build a MongoDB projection document from the field names.
Cache the projection — compute it once, reuse forever.

```rust
#[napi]
pub struct Schema {
    fields: Vec<String>,
    projection: bson::Document,
}

#[napi]
impl Schema {
    #[napi(constructor)]
    pub fn new(field_definitions: String) -> Self {
        let fields: Vec<String> = serde_json::from_str(&field_definitions).unwrap();
        let mut projection = bson::Document::new();
        for field in &fields {
            projection.insert(field, 1);
        }
        Self { fields, projection }
    }
}
```

2. Implement Model in ts/model.ts
```typescript
export class Model {
  private static _schema: any
  private static _collection: Collection

  static define(fields: Record<string, any>, collection: Collection) {
    this._schema = buildSchema(Object.keys(fields))
    this._collection = collection
  }

  static async find(filter: object = {}): Promise<any[]> {
    // projection is automatically applied from schema fields
    const projection = this._schema.getProjection()
    return this._collection.find(filter, { projection })
  }

  static async findOne(filter: object = {}): Promise<any | null> {
    const results = await this.find(filter)
    return results[0] ?? null
  }

  static async findById(id: string): Promise<any | null> {
    return this.findOne({ _id: id })
  }
}
```

3. Write parity tests for Model API
For each method, assert results match what Mongoose would return
for the same query on the same data.

Methods to test:
- Model.find()
- Model.find() with filter
- Model.findOne()
- Model.findById()
- Model.find() with sort option
- Model.find() with limit option
- Model.find() returns only schema-defined fields (projection works)
- Model.find() on empty collection returns []
- Model.findOne() on no match returns null

4. Write Mongoose migration guide as MIGRATION.md
Document every Mongoose method and its equivalent in the new driver.
Note any behavior differences.

### Phase 5 done when
- Model.find(), findOne(), findById() all pass parity tests vs Mongoose
- Projection pushdown confirmed — MongoDB query explain() shows only schema fields fetched
- MIGRATION.md written

---

## Phase 6 — Benchmarking suite

### Goal
Produce benchmark numbers that prove the performance improvement.
These numbers should be reproducible and comparable to Rippling's published results.

### Tasks

1. Build a mock MongoDB wire protocol server in TypeScript
This serves precomputed BSON responses directly from memory.
It eliminates network variance from benchmark results so you measure only client-side performance.
Listen on a TCP socket, respond to OP_MSG find commands with pre-built BSON responses.
This is the same approach Rippling used.

Implement minimal wire protocol support:
- Parse incoming OP_MSG header (16 bytes)
- Parse find command from BSON body
- Respond with pre-built cursor response containing N documents
- Support getMore command for subsequent batches

2. Generate synthetic test data
Create documents with these projection presets matching Rippling's benchmark:
- few: 4 fields, all top-level
- small: 9 fields, mostly top-level
- medium: 15 fields, mix of top-level and nested
- large: 35 fields, many nested
- full: no projection, all ~45 fields including arrays and subdocuments

3. Benchmark find() performance
For each preset run:
- 100,000 documents total, batch size 1000
- Measure total wall time including iteration and field access
- Run 10 iterations, report mean and std deviation
- Compare: official Node.js driver vs your Rust driver

4. Benchmark Model performance
For each preset run:
- 100,000 documents total
- Compare: Mongoose vs your Model class
- Report mean, std deviation, and improvement ratio

5. Measure event loop lag during heavy queries
Run setInterval(() => timestamps.push(Date.now()), 10) during a 100,000 doc query
Compute max jitter (difference between actual and expected interval fire times)
Report: official driver max jitter vs Rust driver max jitter
Rust driver should show near-zero jitter

### Phase 6 done when
- Benchmark suite runs against mock server with deterministic results
- Results show at minimum:
  - 2x improvement over official driver on find()
  - 15x improvement over Mongoose on Model queries
  - Near-zero event loop jitter vs significant jitter with official driver

---

## Phase 7 — Production hardening

### Goal
Make the driver safe to run in production alongside your existing Mongoose code.
Handle errors correctly, add telemetry, test edge cases.

### Tasks

1. Error handling
All Rust errors must be converted to proper JavaScript errors with meaningful messages.
Never panic in production — all unwrap() calls from development phases must be replaced with
proper error propagation using ? operator and napi::Error.

Errors to handle:
- Connection failure
- Authentication failure
- Query timeout
- Invalid BSON in response (should never happen but handle gracefully)
- Cursor already exhausted
- Network interruption mid-cursor

2. Connection management
Implement proper connection pool configuration:
- max_pool_size: configurable, default 10
- min_pool_size: configurable, default 1
- connect_timeout: configurable, default 10s
- server_selection_timeout: configurable, default 30s

The Rust mongodb::Client already handles pooling — expose config options to TypeScript.

3. Logging and telemetry
Add optional debug logging that can be enabled via environment variable MONGOXIDE_DEBUG=1
Log: query start, batch received (with size), parse complete, total time
This is critical for debugging production issues.

4. Resource cleanup
Implement Drop for all Rust structs that hold resources.
Ensure that if a cursor is abandoned (JS code stops iterating), the MongoDB cursor is closed.
Test: create 100 cursors, read 10 docs from each, abandon them, assert no connection leak.

5. Shadow mode support
Add a shadow mode where your Rust driver runs alongside the official driver,
compares results, and logs any differences without affecting the response.
This is how you safely validate in production before full cutover.

```typescript
export async function shadow(
  rustFn: () => Promise<any[]>,
  officialFn: () => Promise<any[]>,
  onDivergence: (diff: any) => void
): Promise<any[]> {
  const [rustResult, officialResult] = await Promise.all([rustFn(), officialFn()])
  if (!deepEqual(rustResult, officialResult)) {
    onDivergence({ rust: rustResult, official: officialResult })
  }
  return officialResult  // always return official result in shadow mode
}
```

6. TypeScript type completeness
Ensure all public API methods have complete TypeScript types.
Run tsc --strict and fix all type errors.
Write a types test file that imports every exported type and asserts its shape.

### Phase 7 done when
- No unwrap() calls in production code paths
- Connection pool config works and is documented
- Shadow mode works — can run both drivers simultaneously and compare
- Resource cleanup test passes — no connection leak on abandoned cursors
- tsc --strict passes with zero errors

---

## Correctness rules — never violate these

1. Never return a different result than the official MongoDB Node.js driver for any read operation.
   If you are unsure whether a behavior matches, write a parity test first.

2. Never panic in code that runs in production.
   All panic-inducing code (unwrap, expect, index out of bounds) must be in tests only.

3. Never hold the napi Env across await points.
   The Env is only valid on the thread that created it.
   Pass data across thread boundaries using channels, not Env references.

4. Never allocate a new tokio runtime per query.
   Create one global runtime at startup and reuse it.

5. Always close MongoDB cursors when the JS cursor is dropped.
   Implement proper cleanup in Drop impls.

---

## Testing commands

```bash
# Run parity tests
npm run test:parity

# Run benchmarks against mock server
npm run bench

# Run integration tests against real MongoDB
MONGODB_URI=mongodb://localhost:27017 npm run test:integration

# Build release binary
npm run build -- --release

# Check for memory leaks
npm run test:leak
```

---

## Definition of done for the entire project

- All parity tests pass (Phase 3 test suite, minimum 23 tests)
- All Model parity tests pass (Phase 5 test suite, minimum 9 tests)
- Benchmark shows minimum 15x improvement over Mongoose on medium projection
- Event loop jitter test shows near-zero jitter with Rust driver
- Shadow mode implemented and tested
- tsc --strict passes
- No memory leaks on cursor abandonment
- README.md written with installation and usage instructions
- MIGRATION.md written with Mongoose → mongoxide-node equivalents

---

## Notes for Claude Code

- Build and test after every phase before proceeding
- When the compiler rejects code due to lifetime or ownership issues, read the error carefully
  before trying to fix it — the compiler is usually telling you the correct solution
- Use Arc<T> for shared ownership across threads, not Rc<T>
- Use tokio::sync primitives (Mutex, RwLock, channel) not std::sync ones in async contexts
- The napi Env cannot be sent across threads — store data as Rust types in channels,
  convert to JS only at the final step when back on the JS thread
- If a test is flaky (sometimes passes, sometimes fails), it is almost certainly a
  race condition — do not ignore it, fix the underlying concurrency issue
- Do not use unsafe unless absolutely necessary and only in deserialize.rs for the
  zero-copy buffer slicing, and document every unsafe block with a comment explaining
  why it is sound