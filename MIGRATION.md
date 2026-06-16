# Migrating from Mongoose to rumongo

rumongo is a **read-path** replacement for Mongoose: faster reads via
Rust-native BSON parsing, off-thread, with optional lazy field access. It does
**not** cover writes, hooks, virtuals, populate, or validation — keep Mongoose
(or the official driver) for those.

## Model definition

**Mongoose**
```js
const User = mongoose.model('User', new mongoose.Schema({ name: String, age: Number }))
```

**rumongo**
```js
import { MongoClient, Model } from 'rumongo'
const client = await MongoClient.connect(uri)
const coll = client.collection('mydb', 'users')
const User = Model.define(coll, { name: 1, age: 1 }) // field list = projection
```

The schema field list becomes a cached projection — MongoDB only sends those
fields (projection pushdown), so less data on the wire and less to parse.

## Read methods

| Mongoose | rumongo | Notes |
|---|---|---|
| `User.find(filter)` | `User.find(filter)` | returns plain objects |
| `User.find(f).sort(s).limit(n)` | `User.find(f, { sort: s, limit: n })` | options object, not chained |
| `User.findOne(filter)` | `User.findOne(filter)` | `null` if no match |
| `User.findById(id)` | `User.findById(idHexString)` | pass the 24-char hex string |
| `.lean()` | (always) | rumongo always returns plain objects |
| `.select('name age')` | (automatic) | the schema fields are the projection |

## Behavior differences

- **No Mongoose Documents.** Results are plain objects (like `.lean()`). No
  `.save()`, no getters/setters, no virtuals.
- **`_id` is a hex string**, not an `ObjectId` instance. Compare with
  `id === doc._id` (string), or convert.
- **Dates** come back as JS `Date` (via `findLazy`/`Model`) — same as Mongoose
  `.lean()`.
- **No `__v`** version key (not in your schema → not projected).
- **Filters with BSON types** use Extended JSON: an ObjectId filter is
  `{ _id: { $oid: '...' } }`. `findById` does this for you.
- **Writes / hooks / populate / validation: not supported.** Use Mongoose or the
  official driver for the write path; use rumongo for hot read paths.

## Advanced: keep the event loop free under load

For heavy concurrent read+aggregate work, run the reduction inside a worker so the
main loop stays responsive (see README / `worker/pool.js`):

```js
import { WorkerPool } from 'rumongo'
const pool = await WorkerPool.create({ uri, size: 6 })
const { acc } = await pool.reduce('mydb', 'users', { active: true }, {}, (a, d) => a + d.age, 0)
```

## Three read APIs (pick by shape)

- `collection.find(filter, opts)` — eager, plain objects. Small/medium results.
- `collection.findLazy(filter, opts)` — Proxy docs; fields parse on access. Wide
  docs where you read few fields.
- `collection.findCursor(filter, opts)` → `nextBatch()` — streaming, bounded
  memory. Large result sets.
- `Model.find/findOne/findById` — Mongoose-style + automatic projection.
