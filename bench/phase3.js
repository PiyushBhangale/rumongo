// Phase 3 bench: off-thread (rayon) parse vs baseline vs official.
//   - rust-base = pipeline:false (Phase 1 standard cursor, inline deserialize)
//   - rust-rayon = pipeline:true (Phase 3 raw batch + rayon parallel parse)
// Measures single large query (wall) and concurrent queries (wall + jitter).

const { MongoClient: Official } = require('mongodb')
const { MongoClient: Rust } = require('../index.js')

const URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/?serverMonitoringMode=poll'
const DB = 'rumongo_bench'
const COLL = 'phase3'
const N_DOCS = Number(process.env.N_DOCS || 100000)
const CONC = Number(process.env.CONC || 20)
const ITERS = Number(process.env.ITERS || 6)

function makeDoc(i) {
  return {
    i,
    name: `user-${i}`,
    email: `user-${i}@example.com`,
    age: 18 + (i % 60),
    active: i % 2 === 0,
    score: (i * 1.5) % 100,
    tags: [`t${i % 5}`, `t${i % 7}`],
    address: { city: `city-${i % 50}`, zip: 10000 + (i % 9000) },
  }
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
  await measure(fn, conc) // warmup
  const walls = []
  const jits = []
  for (let k = 0; k < ITERS; k++) {
    const m = await measure(fn, conc)
    walls.push(m.wall)
    jits.push(m.maxJit)
  }
  console.log(
    `${label.padEnd(12)} wall mean=${mean(walls).toFixed(1)}ms  maxJitter=${maxOf(jits).toFixed(1)}ms`,
  )
  return mean(walls)
}

async function main() {
  console.log(`docs=${N_DOCS} concurrency=${CONC} iters=${ITERS}\n`)
  const official = new Official(URI)
  await official.connect()
  const ocoll = official.db(DB).collection(COLL)
  console.log('seeding...')
  await ocoll.deleteMany({})
  // insert in chunks to avoid a huge single op
  for (let s = 0; s < N_DOCS; s += 20000) {
    await ocoll.insertMany(
      Array.from({ length: Math.min(20000, N_DOCS - s) }, (_, k) => makeDoc(s + k)),
    )
  }
  const rust = await Rust.connect(URI)

  const officialQ = () => ocoll.find({}).toArray()
  const baseQ = () =>
    rust.find(DB, COLL, '{}', '{"pipeline":false}').then((r) => r.map((x) => JSON.parse(x)))
  const rayonQ = () =>
    rust.find(DB, COLL, '{}', '{"pipeline":true}').then((r) => r.map((x) => JSON.parse(x)))

  console.log(`\n=== SINGLE query, ${N_DOCS} docs ===`)
  const o1 = await bench('official', officialQ, 1)
  const b1 = await bench('rust-base', baseQ, 1)
  const r1 = await bench('rust-rayon', rayonQ, 1)
  console.log(`  rayon vs base: ${(b1 / r1).toFixed(2)}x | rayon vs official: ${(o1 / r1).toFixed(2)}x`)

  console.log(`\n=== ${CONC} CONCURRENT queries ===`)
  const o2 = await bench('official', officialQ, CONC)
  const b2 = await bench('rust-base', baseQ, CONC)
  const r2 = await bench('rust-rayon', rayonQ, CONC)
  console.log(`  rayon vs base: ${(b2 / r2).toFixed(2)}x | rayon vs official: ${(o2 / r2).toFixed(2)}x`)

  await ocoll.drop().catch(() => {})
  await official.close()
  await rust.close()
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
