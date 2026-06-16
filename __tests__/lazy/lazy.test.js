// Phase 4 lazy tests: RawDoc field access, to_object parity, Proxy transparency.

const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')

const { MongoClient: OfficialClient, ObjectId } = require('mongodb')
const { MongoClient: RustClient } = require('../../index.js')

const URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/?serverMonitoringMode=poll'
const DB = 'rumongo_lazy'
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

// Normalize rich types to compare lazy output vs official: ObjectId -> hex,
// Date -> epoch ms. (Our converter already yields hex _id and JS Date.)
function canon(v) {
  if (v === null || typeof v !== 'object') return v
  if (v instanceof ObjectId) return v.toHexString()
  if (v instanceof Date) return v.getTime()
  if (typeof v.toHexString === 'function') return v.toHexString()
  if (Array.isArray(v)) return v.map(canon)
  const out = {}
  for (const k of Object.keys(v)) out[k] = canon(v[k])
  return out
}

// Minimal Proxy wrapper mirroring ts/index.ts (so we can test in plain JS).
function wrap(doc) {
  return new Proxy(doc, {
    get(t, p) {
      if (typeof p !== 'string') return undefined
      if (p === 'toObject' || p === 'toJSON') return () => t.toObject()
      if (p === 'then') return undefined
      return t.getField(p)
    },
    has: (t, p) => typeof p === 'string' && t.keys().includes(p),
    ownKeys: (t) => t.keys(),
    getOwnPropertyDescriptor(t, p) {
      if (typeof p === 'string' && t.keys().includes(p)) {
        return { enumerable: true, configurable: true, value: t.getField(p) }
      }
      return undefined
    },
  })
}

test('getField returns correct primitive values', async () => {
  await ocoll.insertOne({ s: 'hi', n: 42, f: 3.5, b: true, z: null })
  const [doc] = await rust.findLazy(DB, COLL, '{}', '{}')
  assert.strictEqual(doc.getField('s'), 'hi')
  assert.strictEqual(doc.getField('n'), 42)
  assert.strictEqual(doc.getField('f'), 3.5)
  assert.strictEqual(doc.getField('b'), true)
  assert.strictEqual(doc.getField('z'), null)
  assert.strictEqual(doc.getField('missing'), undefined)
})

test('getField handles Date, ObjectId, nested, array, buffer', async () => {
  const id = new ObjectId()
  const when = new Date('2024-05-06T07:08:09.000Z')
  await ocoll.insertOne({
    _id: id,
    when,
    nested: { a: 1, b: { c: 2 } },
    arr: [1, 'x', { y: true }],
    buf: Buffer.from([1, 2, 3]),
  })
  const [doc] = await rust.findLazy(DB, COLL, '{}', '{}')
  assert.strictEqual(doc.getField('_id'), id.toHexString())
  const d = doc.getField('when')
  assert.ok(d instanceof Date)
  assert.strictEqual(d.getTime(), when.getTime())
  assert.deepStrictEqual(doc.getField('nested'), { a: 1, b: { c: 2 } })
  assert.deepStrictEqual(doc.getField('arr'), [1, 'x', { y: true }])
  assert.ok(Buffer.isBuffer(doc.getField('buf')))
  assert.deepStrictEqual([...doc.getField('buf')], [1, 2, 3])
})

test('keys lists field names without parsing', async () => {
  await ocoll.insertOne({ a: 1, b: 2, c: 3 })
  const [doc] = await rust.findLazy(DB, COLL, '{}', '{}')
  assert.deepStrictEqual(doc.keys().sort(), ['_id', 'a', 'b', 'c'])
})

test('to_object matches official driver (normalized)', async () => {
  await ocoll.insertMany([
    { _id: new ObjectId(), name: 'A', age: 30, tags: ['x'], at: new Date(1700000000000) },
    { _id: new ObjectId(), name: 'B', age: 31, meta: { k: 'v' } },
  ])
  const lazy = await rust.findLazy(DB, COLL, '{}', JSON.stringify({ sort: { age: 1 } }))
  const off = (await ocoll.find({}, { sort: { age: 1 } }).toArray()).map(canon)
  const ours = lazy.map((d) => canon(d.toObject()))
  assert.deepStrictEqual(ours, off)
})

test('Proxy: dot access, spread, JSON.stringify work transparently', async () => {
  await ocoll.insertOne({ name: 'Jo', age: 7, ok: true })
  const [raw] = await rust.findLazy(DB, COLL, '{}', '{}')
  const doc = wrap(raw)
  assert.strictEqual(doc.name, 'Jo')
  assert.strictEqual(doc.age, 7)
  const spread = { ...doc }
  assert.strictEqual(spread.name, 'Jo')
  assert.strictEqual(spread.ok, true)
  const json = JSON.parse(JSON.stringify(doc))
  assert.strictEqual(json.name, 'Jo')
  assert.strictEqual(json.age, 7)
})

test('partial access does not require reading every field', async () => {
  // 40-field doc; read only 1 field. Must return correct value and not throw.
  const big = { _id: new ObjectId() }
  for (let i = 0; i < 40; i++) big[`f${i}`] = `v${i}`
  await ocoll.insertOne(big)
  const [doc] = await rust.findLazy(DB, COLL, '{}', '{}')
  assert.strictEqual(doc.getField('f7'), 'v7')
  assert.strictEqual(doc.getField('f39'), 'v39')
})
