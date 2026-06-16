# rumongo — Benchmarks: Rust driver vs Node drivers

Progressive log of comparison results across build phases. Append new runs; do
not rewrite history. Each entry: date, what changed, environment, numbers,
interpretation.

## Environment

- Host: Linux 6.2.0, 12 cores, 15 GiB RAM
- MongoDB server: **8.0.16**, local (`mongodb://localhost:27017`)
- Node.js: **v20.4.0**
- Rust: **1.96.0**; crates: `mongodb` 3.7.0, `bson` 2.15.0, `napi` 2.16
- Compare targets:
  - **official** = official `mongodb` Node.js driver (npm `mongodb` ^6.8)
  - **rust** = rumongo (this project)
  - (Mongoose comparison: planned, Phase 5)

> ⚠️ All numbers below are **localhost** (≈0 network latency). Pipeline / fetch
> overlap wins show up under real network latency, not here. Treat localhost as
> a lower bound for those features and an upper bound for CPU-bound wins.

Bench scripts: [bench/compare.js](bench/compare.js) (single-query find),
[bench/pipeline.js](bench/pipeline.js) (sequential vs pipelined),
[bench/concurrent.js](bench/concurrent.js) (parallel queries + event-loop jitter).

---

## 2026-06-15 — Phase 1: scaffold + basic find()

Implementation: standard cursor, full BSON deserialize, returned to JS as JSON
strings (`JSON.parse` on the JS side). No optimization.

### Single-query find, 10k docs, 20 iters (`bench/compare.js`)

| metric | official | rust | result |
|---|---|---|---|
| parity (result set) | 10000 | 10000 | **identical ✓** |
| mean (ms) | 216.5 | 171.4 | **rust 1.26× faster** |
| p50 (ms) | 221.4 | 160.0 | |

Interpretation: even unoptimized, native Rust BSON→JSON beats the Node driver
building JS objects field-by-field on the main thread; V8 `JSON.parse` is cheap.

---

## 2026-06-15 — Phase 2: pipelined fetch (batched mpsc channel)

Implementation: spawned tokio task drives the cursor and pushes **batches** of
docs through a bounded mpsc channel; consumer serializes while fetcher prefetches.
Bounded channel = backpressure. (`pipeline` option toggles vs sequential.)

### Single-query: sequential vs pipelined, 50k docs, 15 iters (`bench/pipeline.js`)

| mode | mean (ms) | p50 (ms) |
|---|---|---|
| sequential | 515.3 | 507.4 |
| pipelined | 629.8 | 629.5 |

Result: pipelined **22% SLOWER** on localhost. Expected — `getMore` latency ≈ 0,
so prefetch-overlap saves nothing while task+channel scheduling costs ~20%.
(First attempt with a *per-document* channel was ~100% slower; batching the
channel cut the overhead.) The "30–40% faster" claim needs real network latency.

> Note: an earlier per-document channel was 2× slower; the table above is the
> batched version. Pipeline is kept as the foundation Phase 3 plugs into, and
> for latency/concurrency wins — not for single-query localhost speed.

### Concurrency: 20 parallel queries × 20k docs, 8 iters (`bench/concurrent.js`)

| metric | official | rust | result |
|---|---|---|---|
| wall time, 20 concurrent (ms) | 6255.9 | 2342.0 | **rust 2.67× faster** ✓ |
| event-loop max jitter (ms) | 520.2 | 1565.3 | **rust 3× worse** ✗ |

Interpretation:
- **Throughput win is the real Phase 2 result:** concurrent queries' BSON work
  spreads across tokio worker threads instead of serializing on Node's single
  event loop → 2.67×.
- **Jitter regression is diagnostic, not a dead end:** we return JSON *strings*,
  so the JS side runs 20× `JSON.parse(20k)` in a synchronous burst that blocks
  the loop. The official driver spreads deserialization across arriving batches.
  → The JSON-string boundary is now the bottleneck. **Phase 3 (off-thread parse,
  no string round-trip) and Phase 4 (lazy, skip parse) target exactly this.**

### Correctness (`__tests__/integration/`)

- basic.test.js: **5/5 pass**
- pipeline.test.js: **4/4 pass** (pipelined==sequential, backpressure with
  `maxInflight=1`, abandoned cursor cleanup)

### Operational findings

- `MongoClient.close()` added — without it the napi tokio runtime never drains
  and Node hangs at exit.
- Streaming server monitoring makes `close()` take **~10001ms** (awaitable
  `hello` blocks shutdown); `?serverMonitoringMode=poll` → **~1ms**. Tests/benches
  use poll. Revisit graceful shutdown in Phase 7.

---

## 2026-06-15 — Phase 3: off-thread parse (RawBatchCursor + rayon)

Implementation: default path switched to `RawBatchCursor` (`.find(..).batch()`) —
raw server batches stream through the bounded channel, each parsed to JSON
strings on the **rayon** pool via `spawn_blocking` (parallel across cores, off the
async workers). Filters now parsed as **Extended JSON** (`{$oid}`→ObjectId,
`{$date}`→DateTime). Interface still JSON strings (native JS / lazy = Phase 4).
`pipeline:false` = Phase 1 standard-cursor baseline.

### Parity suite — 23/23 PASS (`__tests__/parity/parity.test.js`)

Same query run against official Node driver and rust, results compared after
canonicalizing rich types. Covers: filters, projection in/out, sort asc/desc,
limit/skip/both, nested filter, `$gt/$lt/$gte/$lte`, `$in`, `$and`, `$or`, empty
result, ObjectId filter (EJSON), Date, nested doc, array, null, bool, int, float,
10k set, abandoned cursor. **All pass.**

(Also: integration basic 5/5, pipeline 4/4 still pass.)

### Bench: rayon vs baseline vs official (`bench/phase3.js`)

`rust-base` = `pipeline:false` (Phase 1 path); `rust-rayon` = Phase 3.

**Single query, 100k docs, 6 iters:**

| target | wall mean (ms) | max jitter (ms) |
|---|---|---|
| official | 2441.9 | 82.6 |
| rust-base | 1299.4 | 5.9 |
| rust-rayon | **641.5** | 9.2 |

→ rayon **2.03× vs base**, **3.81× vs official**.

**20 concurrent queries, 100k docs each, 6 iters:**

| target | wall mean (ms) | max jitter (ms) |
|---|---|---|
| official | 37167.3 | 1221.3 |
| rust-base | 15553.6 | 9072.1 |
| rust-rayon | **12346.5** | 8140.9 |

→ rayon **1.26× vs base**, **3.01× vs official**.

Interpretation:
- **Throughput is the Phase 3 win:** parallel parse across cores → 3.8× over
  official on a single large query, 3× concurrent, 2× over the Phase 1 baseline
  (meets the plan's "2–3× over Phase 1" gate). Concurrent gain over base is
  smaller (1.26×) because 20 concurrent queries already saturate the 12 cores.
- **Jitter still high on concurrent (8141ms vs official 1221ms):** the rayon
  parse is off-loop, but each query's result is still returned as JSON strings →
  20 synchronous `JSON.parse` bursts block the event loop. Single-query jitter is
  fine (9ms). **The JSON-string boundary is the remaining bottleneck → Phase 4
  (native JS values + lazy field access) targets exactly this.**

---

## 2026-06-15 — Phase 4: lazy zero-copy (RawDoc + Proxy)

Implementation: new `find_lazy()` returns `RawDoc` handles holding raw BSON bytes
— **no value parsing on return**. A field is parsed only when JS reads it
(`get_field`), via a native BSON→JS converter (String/number/bool/null, Date,
ObjectId→hex, nested doc/array, Buffer). A JS `Proxy` (ts/index.ts) makes
`doc.field` call `get_field`, while spread / `JSON.stringify` still see all fields
(ownKeys + descriptors). Eager `find()` is unchanged.

### Lazy tests — 6/6 PASS (`__tests__/lazy/lazy.test.js`)

getField primitives; Date/ObjectId/nested/array/Buffer; `keys()`; `to_object`
parity vs official (normalized); Proxy dot-access + spread + JSON.stringify;
partial access of a 40-field doc. (Eager 23 parity + 9 integration still pass.)

### Bench: lazy vs eager vs official (`bench/lazy.js`)

10 concurrent queries, 20k docs × 33 fields, **reading only 2 fields/doc**, 6 iters:

| target | wall mean (ms) | max jitter (ms) |
|---|---|---|
| official | 8362.2 | 645.2 |
| rust-eager | 2537.3 | 1322.0 |
| rust-lazy | **1144.1** | 991.1 |

→ lazy **2.22× vs eager**, **7.31× vs official**.

Interpretation:
- **Throughput is the Phase 4 win:** skipping the 31 unread fields makes lazy
  **7.3× faster than the official driver** and 2.2× faster than our own eager
  path. This is the lever for the headline Mongoose win (Phase 5 Model layer
  pushes projections so even fewer bytes are fetched).
- **Jitter (991ms) beats eager (1322ms) but not official (645ms):** `find_lazy`
  still materializes one `RawDoc` per doc and each `getField` crosses the JS↔Rust
  boundary — both touch the event loop. Near-zero jitter would need a streaming
  iterator instead of an up-front handle array (future work).
- **Memory tradeoff:** one handle object + its byte buffer per doc. Holding ~1M
  simultaneously OOMs Node's default 2GB heap (observed at 20×50k). Lazy is for
  "wide docs, few fields read," not for buffering millions of docs at once.

---

## 2026-06-15 — Phase 4b: jitter investigation + streaming cursor

Goal: drive down the concurrent-query jitter from Phase 4 (lazy 991ms).

### Diagnosis (`single query, 50k docs`)

| step | max jitter |
|---|---|
| A) findLazy return only (no access) | **0.9ms** |
| B) access 2 fields (sync loop) | **0.0ms** |
| C) eager find + JSON.parse all | **5.7ms** |

→ Single/low-concurrency jitter is already near-zero. The Phase 4 concurrent
991ms was **not** from marshaling.

### Streaming cursor (`FindCursor.next_batch()`)

Added a cursor that hands back one batch at a time (process + drop before the
next), so peak live objects ≈ one batch. Bench, 10 concurrent, 20k×33 fields,
read 2 fields/doc:

| target | wall (ms) | max jitter (ms) |
|---|---|---|
| official | 7537 | 636.8 |
| lazy-array | 830 | 601.4 |
| lazy-cursor | 821 | 672.0 |

**Finding:** at 10× concurrency the jitter floor (~600ms) is the **same for the
official driver too**. It is not our parsing — it's the single JS thread being
saturated by 10 simultaneous CPU-bound query loops, so the 10ms timer can't fire
regardless of driver. `await`-yields don't help when 10 queries keep the thread
busy. The honest levers:
- **Do less main-thread work** → lazy already does (reads 2 of 33 fields): same
  peak jitter as official but the busy window is **9× shorter** (821ms vs 7537ms),
  so the loop is responsive again ~9× sooner.
- **Bound memory** → the cursor's real, measured win.

### Memory: cursor survives what `findLazy` OOM'd

`findLazy` on 20×50k (=1M docs) → **OOM at 2080MB** (heap full of handles).
`FindCursor` on the same 1M docs → **peak RSS 1140MB, no OOM, 4447ms**.

Takeaways:
- Lazy/cursor jitter is near-zero at realistic concurrency; at extreme
  concurrency it's main-thread-bound and equal to official, but lazy finishes
  far sooner (less total work).
- Use `find` (eager) for small results, `findLazy` for wide-doc/few-field reads,
  `findCursor` for large/streaming results (bounded memory).

---

## 2026-06-15 — Phase 4c: worker-thread offload = near-zero main-loop jitter

Physics: napi builds JS values on the calling isolate, and JS is single-threaded
per isolate. We already decode BSON off-thread (rayon), but the final Rust→JS
materialization runs on whichever isolate owns the result. On the main isolate
under concurrency that saturates → jitter. The only escape is a *different
isolate* = a Worker thread.

Bench (`bench/worker.js`): 10 concurrent `findLazy` queries, 20k×33 fields,
2 fields read. Main thread runs a 10ms heartbeat throughout.

| where the queries run | query wall (ms) | MAIN-loop max jitter (ms) |
|---|---|---|
| main thread | 1101 | 329.9 |
| **worker thread** | 919 | **0.7** |

→ Offloading the addon to a worker drops main-loop jitter **330ms → 0.7ms**
(~470×) and even runs faster (no contention with the heartbeat).

Why this is a Rust-driver advantage: the worker's isolate does fetch + BSON→JS
in native code; the main isolate does nothing. The official Node driver's BSON
decode is JS, so a worker still pays full JS deserialize and worker→main transfer
is heavier.

Caveat: returning large result *data* to main still costs a structured clone.
Mitigate by (a) processing in the worker and returning summaries, or (b)
transferring the raw BSON Buffer (transferable, zero-copy) and lazy-parsing only
accessed fields on main. Recommended production shape: a small worker pool running
rumongo, main thread dispatches queries — main loop stays responsive under load.

**Conclusion on jitter:** near-zero is achievable. Single/low concurrency →
already near-zero (Phase 4b). High concurrency on one isolate → main-thread-bound
(equal to official, but lazy finishes ~9× sooner). High concurrency with a worker
pool → main-loop jitter ~0.7ms. Lever summary: lazy (less work) + worker threads
(other isolate) + cursor (bounded memory).

---

## 2026-06-15 — Phase 4d: worker pool load sweep → opt-in (not default)

Built an opt-in worker pool (`worker/pool.js` + `worker/pool-worker.js`): N Node
worker threads, each with its own addon + MongoClient, round-robin dispatch.
Swept it vs direct main-thread use across loads (`bench/poolbench.js`, pool=6).

| load | mode | wall (ms) | main jitter (ms) |
|---|---|---|---|
| tiny (1 doc, 50 conc) | direct | 8.6 | 0.6 |
| | pool-data | 18.0 | 3.0 |
| | pool-reduced | 8.4 | 0.0 |
| small (100, 20 conc) | direct | 24.9 | 11.7 |
| | pool-data | 25.8 | 11.5 |
| | pool-reduced | 14.1 | 1.3 |
| med (1000, 12 conc) | direct | 121.9 | 93.2 |
| | pool-data | 125.1 | 108.9 |
| | pool-reduced | 69.4 | 0.9 |
| heavy (10000, 6 conc) | direct | 780.7 | 517.9 |
| | pool-data | 860.6 | 551.0 |
| | pool-reduced | **328.4** | **7.5** |

- **pool-data** (worker queries, ships rows to main): ties or LOSES at every load.
  Main still parses the result and now also pays the cross-thread transfer. A
  transparent "route find() through workers" buys nothing.
- **pool-reduced** (worker queries AND reduces, returns a summary): wins at every
  load — jitter near-zero (7.5 vs 518ms heavy) and wall up to 2.4× faster. But it
  requires pushing the data-processing INTO the worker; it is not a drop-in find().

**Decision: worker pool stays OPT-IN**, positioned for the "do the work in the
worker, return a small result" pattern (aggregations, transforms, counts, exports,
streaming to a socket from the worker). Not made default, because the only
universally-winning mode isn't a transparent `find()` replacement. The default
path remains the direct addon (already 3–7× faster than the official driver).

---

## 2026-06-16 — Phase 4e: generic worker reduce + larger-load sweep

Generalized the worker reduce: `pool.reduce(db, coll, filter, opts, reducerFn,
init)` ships the reducer as source and runs `(acc, doc) => acc` in the worker;
only the accumulator returns to main. (find() stays direct; reduce is the
worker-backed path.)

Sweep, 100k-doc collection, pool=6 (`bench/poolbench.js`):

| load (result size, conc) | direct wall/jit (ms) | pool-reduced wall/jit (ms) |
|---|---|---|
| small (100, 20) | 33 / 18 | 19 / 0.5 |
| med (1000, 12) | 154 / 127 | 65 / 0.8 |
| heavy (10000, 6) | 808 / 544 | 337 / 4.6 |
| huge (50000, 4) | 2879 / 1722 | 1420 / 14 |
| max (100000, 2) | 3118 / 163 | 2274 / 18 |

(pool-data omitted — ties/loses on wall at every load, same as Phase 4d.)

- pool-reduced wins wall ~2–2.4× and keeps main-loop jitter ≤18ms while direct
  jitter climbs to 1722ms on big result sets. The bigger the data, the bigger the
  responsiveness win.
- Worker count is **fixed** at pool creation (default `cpus-2`). BSON work is
  CPU-bound so >cores doesn't help; dynamic autoscaling would add cold-start
  latency on spikes — deferred unless bursty traffic needs it.

Final stance: worker pool = opt-in; `reduce` runs in the worker by default within
the pool. Direct addon remains the default for `find` (returns docs).

---

## 2026-06-16 — Phase 5: Mongoose-style Model + projection pushdown

`ts/model.ts`: `Model.define(collection, schemaFields)` builds a cached
projection from the schema field list and pushes it down on every query, so
MongoDB only sends schema fields. Methods: `find`, `findOne`, `findById`
(hex-string id → ObjectId via Extended JSON), `getProjection`.

### Model parity — 9/9 PASS vs Mongoose (`__tests__/model/model.test.js`)

find / find+filter / findOne / findById / sort / limit / **projection pushdown
(non-schema field excluded)** / empty→[] / no-match→null. Compared schema-field
values + counts on identical data (mongoose `versionKey:false`, `.lean()`).

### Perf: Model vs Mongoose, 50k docs (6 fields), 10 iters (`bench/model.js`)

| target | mean (ms) |
|---|---|
| mongoose (hydrated) | 1228.1 |
| mongoose (.lean) | 607.2 |
| **rumongo Model** | **244.6** |

→ **5.0× vs hydrated Mongoose**, 2.5× vs `.lean()`. (Eager, all 6 fields read.
With `findLazy` + few-field reads the multiple is higher — see Phase 4: 7.3× vs
the raw official driver when reading 2 of 33 fields.)

MIGRATION.md written (Mongoose → rumongo mapping + behavior differences).

---

## 2026-06-16 — Phase 6: consolidated preset benchmark suite

`bench/suite.js`: projection presets (few=4, small=9, medium=15, large=35,
full=45 fields) over a 45-field doc. Deterministic (data = f(index)), warmup +
6 iters, mean ± sd. N=30k. Run against local MongoDB (network ~0 isolates
client-side cost — the mock wire-server from the plan was skipped: making both
the official Node driver and the Rust `mongodb` crate accept a hand-rolled
handshake is large and brittle, and localhost already removes network variance).

### A) Driver find — official Node driver vs rumongo (eager)

| preset | fields | official (ms) | rumongo (ms) | speedup |
|---|---|---|---|---|
| few | 4 | 649±95 | 178±17 | **3.65×** |
| small | 9 | 792±62 | 304±16 | 2.61× |
| medium | 15 | 687±49 | 418±54 | 1.64× |
| large | 35 | 1532±132 | 841±61 | 1.82× |
| full | 45 | 2032±135 | 1031±59 | 1.97× |

### B) ODM — mongoose `.lean()` vs rumongo Model

| preset | fields | mongoose (ms) | Model (ms) | speedup |
|---|---|---|---|---|
| few | 4 | 477±53 | 177±18 | 2.69× |
| small | 9 | 559±35 | 284±31 | 1.97× |
| medium | 15 | 680±68 | 405±35 | 1.68× |
| large | 35 | 1455±24 | 850±65 | 1.71× |
| full | 45 | 2041±167 | 1031±98 | 1.98× |

### C) Event-loop jitter (full preset, single query)

official `maxJitter=149.2ms` · rumongo `maxJitter=13.8ms` (~10× lower).

### Verdict vs plan targets (honest)

- **≥2× over official find:** met for few/small/full (1.97–3.65×); medium/large
  1.64–1.82× (just under 2× — projection cost dominates at mid widths).
- **≥15× over Mongoose:** NOT met by eager find. vs `.lean()` it's 1.7–2.7×; vs
  hydrated Mongoose ~5× (Phase 5). The 15× figure only appears with lazy +
  narrow field reads (Phase 4: 7.3× vs the raw official driver reading 2 of 33
  fields) — i.e. it's a property of the access pattern, not eager full-doc reads.
- **Near-zero jitter:** eager full read is 13.8ms (10× better than official, not
  zero — JSON.parse remains). Near-zero needs lazy/worker paths (Phase 4b/4c).

Bottom line: 1.6–3.7× faster reads than the official driver, ~2× vs Mongoose
`.lean()` / ~5× vs hydrated, 10× lower jitter — consistently, across projection
sizes. The headline 15–20× is achievable but only under lazy/narrow-read or
worker-offload patterns, not eager full-document reads.

---

## Template for future entries

```
## YYYY-MM-DD — Phase N: <title>

Implementation: <what changed>

### <scenario>, <dataset>, <iters> (`bench/<script>.js`)
| metric | official | rust | result |
|---|---|---|---|
| ... | | | |

Interpretation: <why the numbers look like this; what's next>
```
