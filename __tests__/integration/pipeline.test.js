// Phase 2 tests: pipelined result correctness + backpressure (tiny channel).

const { test, before, after } = require('node:test')
const assert = require('node:assert')

const { MongoClient: OfficialClient } = require('mongodb')
const { MongoClient: RustClient } = require('../../index.js')

// poll monitoring => fast close() (see basic.test.js / Phase 7 notes).
const URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/?serverMonitoringMode=poll'
const DB = 'rumongo_test'
const COLL = 'phase2_pipeline'
const N = 10000

let official
let rust

before(async () => {
  official = new OfficialClient(URI)
  await official.connect()
  const coll = official.db(DB).collection(COLL)
  await coll.deleteMany({})
  await coll.insertMany(
    Array.from({ length: N }, (_, i) => ({ i, name: `d-${i}`, even: i % 2 === 0 })),
  )
  rust = await RustClient.connect(URI)
})

after(async () => {
  if (official) {
    await official.db(DB).collection(COLL).drop().catch(() => {})
    await official.close()
  }
  // close() drains driver monitors so Node can exit (~10s; see Phase 7).
  if (rust) await rust.close()
})

test('pipelined returns all docs', async () => {
  const rows = await rust.find(DB, COLL, '{}', JSON.stringify({ pipeline: true }))
  assert.strictEqual(rows.length, N)
})

test('pipelined == sequential (identical result set)', async () => {
  const p = await rust.find(DB, COLL, '{}', JSON.stringify({ pipeline: true, sort: { i: 1 } }))
  const s = await rust.find(DB, COLL, '{}', JSON.stringify({ pipeline: false, sort: { i: 1 } }))
  assert.strictEqual(p.length, s.length)
  assert.deepStrictEqual(p, s) // same JSON strings, same order
})

test('backpressure: tiny channel + slow consumer still yields all docs in order', async () => {
  // maxInflight=1 forces the fetcher to park constantly; correctness must hold.
  const rows = await rust.find(
    DB,
    COLL,
    '{}',
    JSON.stringify({ pipeline: true, maxInflight: 1, batchSize: 100, sort: { i: 1 } }),
  )
  assert.strictEqual(rows.length, N)
  const parsed = rows.map((r) => JSON.parse(r))
  assert.strictEqual(parsed[0].i, 0)
  assert.strictEqual(parsed[N - 1].i, N - 1)
  // monotonic order preserved through the channel
  for (let i = 1; i < parsed.length; i++) {
    assert.ok(parsed[i].i === parsed[i - 1].i + 1)
  }
})

test('abandoned cursor (small limit) does not hang or leak', async () => {
  // consumer reads a bounded slice; pipeline drops, fetcher stops cleanly.
  const rows = await rust.find(DB, COLL, '{}', JSON.stringify({ limit: 5, pipeline: true }))
  assert.strictEqual(rows.length, 5)
})
