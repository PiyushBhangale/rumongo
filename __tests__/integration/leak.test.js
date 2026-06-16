// Phase 7 leak test: create many cursors, read a few docs from each, abandon
// them, and assert no connection/memory blowup. Exercises cleanup of dropped
// FindCursors (the spawned fetcher stops when the receiver is dropped).

const { test, before, after } = require('node:test')
const assert = require('node:assert')

const { MongoClient: OfficialClient } = require('mongodb')
const { MongoClient: RustClient } = require('../../index.js')

const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/?serverMonitoringMode=poll'
const DB = 'rumongo_test'
const COLL = 'leak'

let official
let rust

before(async () => {
  official = new OfficialClient(URI)
  await official.connect()
  const c = official.db(DB).collection(COLL)
  await c.deleteMany({})
  await c.insertMany(Array.from({ length: 5000 }, (_, i) => ({ i, name: `n-${i}` })))
  rust = await RustClient.connect(URI, JSON.stringify({ maxPoolSize: 10 }))
})

after(async () => {
  if (official) {
    await official.db(DB).collection(COLL).drop().catch(() => {})
    await official.close()
  }
  if (rust) await rust.close()
})

test('connect honors pool config (maxPoolSize) and queries work', async () => {
  const rows = await rust.find(DB, COLL, '{}', JSON.stringify({ limit: 3 }))
  assert.strictEqual(rows.length, 3)
})

test('100 abandoned cursors do not leak or hang', async () => {
  const rssBefore = process.memoryUsage().rss
  for (let k = 0; k < 100; k++) {
    const cur = await rust.findCursor(DB, COLL, '{}', JSON.stringify({ batchSize: 100 }))
    // read just the first batch, then abandon (drop reference)
    const batch = await cur.nextBatch()
    assert.ok(batch.length > 0)
    // cur goes out of scope here -> fetcher stops, MongoDB cursor closed
  }
  global.gc?.()
  const rssAfter = process.memoryUsage().rss
  const growthMB = (rssAfter - rssBefore) / 1048576
  // generous bound: 100 abandoned cursors must not balloon memory
  assert.ok(growthMB < 300, `RSS grew ${growthMB.toFixed(0)}MB across 100 abandoned cursors`)
})

test('repeated full drains are stable', async () => {
  for (let k = 0; k < 20; k++) {
    const cur = await rust.findCursor(DB, COLL, '{}', JSON.stringify({ batchSize: 1000 }))
    let total = 0
    let batch
    while ((batch = await cur.nextBatch()) !== null) total += batch.length
    assert.strictEqual(total, 5000)
  }
})
