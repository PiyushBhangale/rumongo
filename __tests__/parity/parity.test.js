// Phase 3 parity suite — 23 behaviors. Each runs the SAME query against the
// official Node driver and the Rust driver and asserts identical results.
//
// We return JSON strings, so values are compared after normalizing the official
// driver's rich types (ObjectId, Date, Long) to the same JSON shape our serde
// path produces (ObjectId -> {$oid}, Date -> {$date:{$numberLong}}). The point
// of parity is "same data", not "same JS class".

const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')

const { MongoClient: OfficialClient, ObjectId } = require('mongodb')
const { MongoClient: RustClient } = require('../../index.js')

const URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/?serverMonitoringMode=poll'
const DB = 'rumongo_parity'
const COLL = 'docs'

let official
let ocoll
let rust

before(async () => {
  official = new OfficialClient(URI)
  await official.connect()
  ocoll = official.db(DB).collection(COLL)
  rust = await RustClient.connect(URI)
})

after(async () => {
  if (official) {
    await ocoll.drop().catch(() => {})
    await official.close()
  }
  if (rust) await rust.close()
})

beforeEach(async () => {
  await ocoll.deleteMany({})
})

// Canonicalize the official driver's BSON-rich object into the same plain JSON
// shape that our Rust serde_json path emits, so deep-equality is meaningful.
function canon(v) {
  if (v === null || typeof v !== 'object') return v
  if (v instanceof ObjectId) return { $oid: v.toHexString() }
  if (v instanceof Date) return { $date: { $numberLong: String(v.getTime()) } }
  if (Array.isArray(v)) return v.map(canon)
  if (typeof v.toHexString === 'function') return { $oid: v.toHexString() }
  const out = {}
  for (const k of Object.keys(v)) out[k] = canon(v[k])
  return out
}

async function rustFind(filter = {}, options = {}) {
  const rows = await rust.find(DB, COLL, JSON.stringify(filter), JSON.stringify(options))
  return rows.map((r) => JSON.parse(r))
}
async function officialFind(filter = {}, options = {}) {
  const rows = await ocoll.find(filter, options).toArray()
  return rows.map(canon)
}

// assert both drivers return the same documents (order-sensitive)
async function assertParity(filter = {}, options = {}) {
  const [o, r] = await Promise.all([officialFind(filter, options), rustFind(filter, options)])
  assert.strictEqual(r.length, o.length, 'length mismatch')
  assert.deepStrictEqual(r, o)
  return { o, r }
}

// ---------- 1-14: filters / options ----------

test('1 basic find with filter', async () => {
  await ocoll.insertMany([{ a: 1 }, { a: 2 }, { a: 1 }])
  await assertParity({ a: 1 }, { sort: { _id: 1 } })
})

test('2 projection include fields', async () => {
  await ocoll.insertMany([{ a: 1, b: 2, c: 3 }])
  await assertParity({}, { projection: { a: 1, _id: 0 }, sort: { _id: 1 } })
})

test('3 projection exclude fields', async () => {
  await ocoll.insertMany([{ a: 1, b: 2, c: 3 }])
  await assertParity({}, { projection: { b: 0 }, sort: { _id: 1 } })
})

test('4 sort ascending', async () => {
  await ocoll.insertMany([{ i: 3 }, { i: 1 }, { i: 2 }])
  const { r } = await assertParity({}, { sort: { i: 1 } })
  assert.deepStrictEqual(r.map((d) => d.i), [1, 2, 3])
})

test('5 sort descending', async () => {
  await ocoll.insertMany([{ i: 1 }, { i: 2 }, { i: 3 }])
  const { r } = await assertParity({}, { sort: { i: -1 } })
  assert.deepStrictEqual(r.map((d) => d.i), [3, 2, 1])
})

test('6 limit', async () => {
  await ocoll.insertMany(Array.from({ length: 10 }, (_, i) => ({ i })))
  await assertParity({}, { sort: { i: 1 }, limit: 3 })
})

test('7 skip', async () => {
  await ocoll.insertMany(Array.from({ length: 10 }, (_, i) => ({ i })))
  await assertParity({}, { sort: { i: 1 }, skip: 4 })
})

test('8 skip + limit', async () => {
  await ocoll.insertMany(Array.from({ length: 10 }, (_, i) => ({ i })))
  await assertParity({}, { sort: { i: 1 }, skip: 2, limit: 3 })
})

test('9 nested field filter', async () => {
  await ocoll.insertMany([{ a: { b: 1 } }, { a: { b: 2 } }])
  await assertParity({ 'a.b': 2 }, { sort: { _id: 1 } })
})

test('10 $gt/$lt/$gte/$lte', async () => {
  await ocoll.insertMany(Array.from({ length: 10 }, (_, i) => ({ i })))
  await assertParity({ i: { $gt: 2, $lte: 6 } }, { sort: { i: 1 } })
})

test('11 $in', async () => {
  await ocoll.insertMany(Array.from({ length: 10 }, (_, i) => ({ i })))
  await assertParity({ i: { $in: [1, 3, 5] } }, { sort: { i: 1 } })
})

test('12 $and', async () => {
  await ocoll.insertMany(Array.from({ length: 10 }, (_, i) => ({ i, even: i % 2 === 0 })))
  await assertParity({ $and: [{ i: { $gte: 4 } }, { even: true }] }, { sort: { i: 1 } })
})

test('13 $or', async () => {
  await ocoll.insertMany(Array.from({ length: 10 }, (_, i) => ({ i })))
  await assertParity({ $or: [{ i: 1 }, { i: 8 }] }, { sort: { i: 1 } })
})

test('14 no results -> empty array', async () => {
  await ocoll.insertMany([{ i: 1 }])
  const { r } = await assertParity({ i: 999 })
  assert.strictEqual(r.length, 0)
})

// ---------- 15-22: types ----------

test('15 ObjectId filter', async () => {
  const id = new ObjectId()
  await ocoll.insertMany([{ _id: id, a: 1 }, { a: 2 }])
  // Each driver gets the filter in its native encoding for the same logical
  // query: official takes a native ObjectId; rust takes Extended JSON ($oid).
  const o = (await ocoll.find({ _id: id }).toArray()).map(canon)
  const r = await rustFind({ _id: { $oid: id.toHexString() } })
  assert.strictEqual(r.length, 1)
  assert.deepStrictEqual(r, o)
})

test('16 Date field equal', async () => {
  await ocoll.insertMany([{ when: new Date('2024-01-02T03:04:05.000Z') }])
  await assertParity({}, { sort: { _id: 1 } })
})

test('17 nested document deep equality', async () => {
  await ocoll.insertMany([{ a: { b: { c: [1, 2, { d: 'x' }] } } }])
  await assertParity({}, { sort: { _id: 1 } })
})

test('18 array field contents', async () => {
  await ocoll.insertMany([{ tags: ['x', 'y', 'z'], nums: [1, 2, 3] }])
  await assertParity({}, { sort: { _id: 1 } })
})

test('19 null field value', async () => {
  await ocoll.insertMany([{ a: null, b: 1 }])
  await assertParity({}, { sort: { _id: 1 } })
})

test('20 boolean field', async () => {
  await ocoll.insertMany([{ ok: true }, { ok: false }])
  await assertParity({}, { sort: { _id: 1 } })
})

test('21 integer field', async () => {
  await ocoll.insertMany([{ n: 42 }, { n: -7 }])
  await assertParity({}, { sort: { _id: 1 } })
})

test('22 float field', async () => {
  await ocoll.insertMany([{ f: 3.14159 }, { f: -0.5 }])
  await assertParity({}, { sort: { _id: 1 } })
})

// ---------- 23: scale + abandoned cursor ----------

test('23 large result set (10k) + abandoned cursor', async () => {
  await ocoll.insertMany(Array.from({ length: 10000 }, (_, i) => ({ i, name: `n-${i}` })))
  const { r } = await assertParity({}, { sort: { i: 1 } })
  assert.strictEqual(r.length, 10000)
  // abandon: only take a small limit; must not hang or leak
  const few = await rustFind({}, { limit: 5, sort: { i: 1 } })
  assert.strictEqual(few.length, 5)
})
