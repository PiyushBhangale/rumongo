// Phase 4 streaming bench: lazy-array vs lazy-CURSOR vs official.
// The cursor processes one batch at a time (process + drop), so peak live
// objects ≈ one batch → much less GC → lower jitter under concurrency.

const { MongoClient: Official } = require('mongodb')
const { MongoClient: Rust } = require('../index.js')

const URI = 'mongodb://localhost:27017/?serverMonitoringMode=poll'
const DB = 'rumongo_bench', COLL = 'stream'
const N_DOCS = Number(process.env.N_DOCS || 20000)
const CONC = Number(process.env.CONC || 10)
const ITERS = Number(process.env.ITERS || 6)
const FIELDS = 30

function makeDoc(i) { const d = { i, name: `u${i}` }; for (let k = 0; k < FIELDS; k++) d[`f${k}`] = `v${i}-${k}`; return d }
const mean = (t) => t.reduce((a, b) => a + b, 0) / t.length
const maxOf = (t) => t.reduce((a, b) => Math.max(a, b), 0)

async function measure(fn, conc) {
  const j = []; let last = process.hrtime.bigint()
  const t = setInterval(() => { const n = process.hrtime.bigint(); j.push(Number(n - last) / 1e6 - 10); last = n }, 10)
  const t0 = process.hrtime.bigint()
  await Promise.all(Array.from({ length: conc }, () => fn()))
  const wall = Number(process.hrtime.bigint() - t0) / 1e6
  clearInterval(t)
  return { wall, maxJit: j.length ? maxOf(j) : 0 }
}
async function bench(label, fn, conc) {
  await measure(fn, conc)
  const w = [], jj = []
  for (let k = 0; k < ITERS; k++) { const m = await measure(fn, conc); w.push(m.wall); jj.push(m.maxJit) }
  console.log(`${label.padEnd(13)} wall mean=${mean(w).toFixed(1)}ms  maxJitter=${maxOf(jj).toFixed(1)}ms`)
}

async function main() {
  console.log(`docs=${N_DOCS} fields=${FIELDS} conc=${CONC} read=2 fields/doc\n`)
  const official = new Official(URI); await official.connect()
  const ocoll = official.db(DB).collection(COLL)
  console.log('seeding...')
  await ocoll.deleteMany({})
  for (let s = 0; s < N_DOCS; s += 10000) await ocoll.insertMany(Array.from({ length: Math.min(10000, N_DOCS - s) }, (_, k) => makeDoc(s + k)))
  const rust = await Rust.connect(URI)

  const officialQ = async () => { const docs = await ocoll.find({}).toArray(); let a = 0; for (const d of docs) a += d.i; return a }
  const lazyArrayQ = async () => { const docs = await rust.findLazy(DB, COLL, '{}', '{}'); let a = 0; for (const d of docs) a += d.getField('i'); return a }
  const cursorQ = async () => {
    const cur = await rust.findCursor(DB, COLL, '{}', '{}')
    let a = 0, batch
    while ((batch = await cur.nextBatch()) !== null) {
      for (const d of batch) a += d.getField('i')
    }
    return a
  }

  console.log(`=== ${CONC} concurrent queries ===`)
  await bench('official', officialQ, CONC)
  await bench('lazy-array', lazyArrayQ, CONC)
  await bench('lazy-cursor', cursorQ, CONC)

  await ocoll.drop().catch(() => {}); await official.close(); await rust.close(); process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
