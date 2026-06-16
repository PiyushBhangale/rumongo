// Phase 1 integration test: seed via official driver, read via rumongo.
// Requires a running MongoDB; defaults to mongodb://localhost:27017.

const { test, before, after } = require('node:test')
const assert = require('node:assert')

const { MongoClient: OfficialClient } = require('mongodb')
// Native binding generated at repo root by `napi build`.
const { MongoClient: RustClient } = require('../../index.js')

// poll monitoring => close() returns in ~1ms instead of ~10s (streaming
// monitor holds an awaitable hello that blocks shutdown). See Phase 7 notes.
const URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/?serverMonitoringMode=poll'
const DB = 'rumongo_test'
const COLL = 'phase1_basic'

let official
let rust

const SEED = Array.from({ length: 10 }, (_, i) => ({
  i,
  name: `doc-${i}`,
  even: i % 2 === 0,
}))

before(async () => {
  official = new OfficialClient(URI)
  await official.connect()
  const coll = official.db(DB).collection(COLL)
  await coll.deleteMany({})
  await coll.insertMany(SEED.map((d) => ({ ...d })))

  rust = await RustClient.connect(URI)
})

after(async () => {
  if (official) {
    await official.db(DB).collection(COLL).drop().catch(() => {})
    await official.close()
  }
  // close() shuts down the driver's background monitors; without it the napi
  // tokio runtime never drains and Node hangs at exit. (~10s; see Phase 7.)
  if (rust) await rust.close()
})

test('find with empty filter returns all 10 docs', async () => {
  const rows = await rust.find(DB, COLL, '{}', '{}')
  assert.strictEqual(rows.length, 10)
})

test('find with filter returns matching docs', async () => {
  const rows = await rust.find(DB, COLL, JSON.stringify({ even: true }), '{}')
  const parsed = rows.map((r) => JSON.parse(r))
  assert.strictEqual(parsed.length, 5)
  assert.ok(parsed.every((d) => d.even === true))
})

test('find with exact match returns one doc with correct fields', async () => {
  const rows = await rust.find(DB, COLL, JSON.stringify({ i: 3 }), '{}')
  const parsed = rows.map((r) => JSON.parse(r))
  assert.strictEqual(parsed.length, 1)
  assert.strictEqual(parsed[0].name, 'doc-3')
  assert.strictEqual(parsed[0].even, false)
})

test('find with sort + limit option works', async () => {
  const opts = JSON.stringify({ sort: { i: -1 }, limit: 3 })
  const rows = await rust.find(DB, COLL, '{}', opts)
  const parsed = rows.map((r) => JSON.parse(r))
  assert.strictEqual(parsed.length, 3)
  assert.deepStrictEqual(
    parsed.map((d) => d.i),
    [9, 8, 7],
  )
})

test('find with no match returns empty array', async () => {
  const rows = await rust.find(DB, COLL, JSON.stringify({ i: 999 }), '{}')
  assert.strictEqual(rows.length, 0)
})
