// Phase 4 bench: lazy vs eager vs official, accessing only a FEW fields per doc
// (the realistic case). Measures wall time + event-loop jitter.
//
// Lazy should show low jitter: findLazy returns byte handles without parsing, so
// the return doesn't block the loop; only the few accessed fields are parsed.

const { MongoClient: Official } = require('mongodb')
const { MongoClient: Rust } = require('../index.js')

const URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/?serverMonitoringMode=poll'
const DB = 'rumongo_bench'
const COLL = 'lazy'
// NOTE: lazy materializes one handle object per doc; N_DOCS*CONC handles are
// live at once. Keep the product modest (default 200k) or Node OOMs.
const N_DOCS = Number(process.env.N_DOCS || 20000)
const CONC = Number(process.env.CONC || 10)
const ITERS = Number(process.env.ITERS || 6)
const FIELDS = 30 // wide docs

function makeDoc(i) {
  const d = { i, name: `user-${i}`, email: `u${i}@x.com` }
  for (let k = 0; k < FIELDS; k++) d[`f${k}`] = `value-${i}-${k}`
  return d
}
const mean = (t) => t.reduce((a, b) => a + b, 0) / t.length
const maxOf = (t) => t.reduce((a, b) => Math.max(a, b), 0)

async function measure(fn, conc) {
  const jit = []
  let last = process.hrtime.bigint()
  const timer = setInterval(() => {
    const now = process.hrtime.bigint()
    jit.push(Number(now - last) / 1e6 - 10)
    last = now
  }, 10)
  const t0 = process.hrtime.bigint()
  await Promise.all(Array.from({ length: conc }, () => fn()))
  const wall = Number(process.hrtime.bigint() - t0) / 1e6
  clearInterval(timer)
  return { wall, maxJit: jit.length ? maxOf(jit) : 0 }
}

async function bench(label, fn, conc) {
  await measure(fn, conc)
  const walls = []
  const jits = []
  for (let k = 0; k < ITERS; k++) {
    const m = await measure(fn, conc)
    walls.push(m.wall)
    jits.push(m.maxJit)
  }
  console.log(`${label.padEnd(12)} wall mean=${mean(walls).toFixed(1)}ms  maxJitter=${maxOf(jits).toFixed(1)}ms`)
  return mean(walls)
}

async function main() {
  console.log(`docs=${N_DOCS} fields=${FIELDS} concurrency=${CONC} read=2 fields/doc\n`)
  const official = new Official(URI)
  await official.connect()
  const ocoll = official.db(DB).collection(COLL)
  console.log('seeding...')
  await ocoll.deleteMany({})
  for (let s = 0; s < N_DOCS; s += 10000) {
    await ocoll.insertMany(Array.from({ length: Math.min(10000, N_DOCS - s) }, (_, k) => makeDoc(s + k)))
  }
  const rust = await Rust.connect(URI)

  // each query reads only 2 fields per returned doc, then sums (forces access)
  const officialQ = async () => {
    const docs = await ocoll.find({}).toArray()
    let acc = 0
    for (const d of docs) acc += d.i + (d.name ? d.name.length : 0)
    return acc
  }
  const eagerQ = async () => {
    const rows = await rust.find(DB, COLL, '{}', '{}')
    let acc = 0
    for (const r of rows) {
      const d = JSON.parse(r)
      acc += d.i + (d.name ? d.name.length : 0)
    }
    return acc
  }
  const lazyQ = async () => {
    const docs = await rust.findLazy(DB, COLL, '{}', '{}')
    let acc = 0
    for (const d of docs) acc += d.getField('i') + String(d.getField('name')).length
    return acc
  }

  console.log(`\n=== ${CONC} concurrent queries, read 2 of ${FIELDS + 3} fields/doc ===`)
  const o = await bench('official', officialQ, CONC)
  const e = await bench('rust-eager', eagerQ, CONC)
  const l = await bench('rust-lazy', lazyQ, CONC)
  console.log(`\n  lazy vs eager: ${(e / l).toFixed(2)}x | lazy vs official: ${(o / l).toFixed(2)}x`)

  await ocoll.drop().catch(() => {})
  await official.close()
  await rust.close()
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
