// Phase 2 concurrency bench: many find() calls IN FLIGHT AT ONCE.
// This is where a Rust driver should win vs the official Node driver: BSON work
// for N concurrent queries runs across the tokio runtime's worker threads,
// while the official driver does all deserialization on the single JS event loop.
//
// Two things measured:
//   1) total wall time to resolve C concurrent queries
//   2) event-loop responsiveness DURING those queries (setInterval jitter):
//      how late a 10ms timer fires while the driver is busy.

const { MongoClient: Official } = require('mongodb')
const { MongoClient: Rust } = require('../index.js')

const URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/?serverMonitoringMode=poll'
const DB = 'rumongo_bench'
const COLL = 'concurrent'
const N_DOCS = Number(process.env.N_DOCS || 20000)
const CONC = Number(process.env.CONC || 20) // concurrent queries
const ITERS = Number(process.env.ITERS || 8)

function makeDoc(i) {
  return {
    i,
    name: `user-${i}`,
    email: `user-${i}@example.com`,
    age: 18 + (i % 60),
    tags: [`t${i % 5}`, `t${i % 7}`],
    address: { city: `city-${i % 50}`, zip: 10000 + (i % 9000) },
  }
}

function stats(t) {
  const s = [...t].sort((a, b) => a - b)
  return {
    mean: t.reduce((a, b) => a + b, 0) / t.length,
    p50: s[Math.floor(s.length / 2)],
    max: s[s.length - 1],
  }
}

// run `fn` C times concurrently, measure wall time + max event-loop jitter
async function measure(fn, conc) {
  const expected = 10
  const jit = []
  let last = process.hrtime.bigint()
  const timer = setInterval(() => {
    const now = process.hrtime.bigint()
    jit.push(Number(now - last) / 1e6 - expected)
    last = now
  }, expected)

  const t0 = process.hrtime.bigint()
  await Promise.all(Array.from({ length: conc }, () => fn()))
  const wall = Number(process.hrtime.bigint() - t0) / 1e6

  clearInterval(timer)
  const maxJit = jit.length ? Math.max(...jit) : 0
  return { wall, maxJit }
}

async function main() {
  console.log(`docs=${N_DOCS} concurrency=${CONC} iters=${ITERS}\n`)
  const official = new Official(URI)
  await official.connect()
  const ocoll = official.db(DB).collection(COLL)
  console.log('seeding...')
  await ocoll.deleteMany({})
  await ocoll.insertMany(Array.from({ length: N_DOCS }, (_, i) => makeDoc(i)))

  const rust = await Rust.connect(URI)

  const officialQ = () => ocoll.find({}).toArray()
  const rustQ = () => rust.find(DB, COLL, '{}', '{}').then((r) => r.map((x) => JSON.parse(x)))

  // warmup
  await measure(officialQ, CONC)
  await measure(rustQ, CONC)

  const ow = []
  const oj = []
  const rw = []
  const rj = []
  for (let k = 0; k < ITERS; k++) {
    const o = await measure(officialQ, CONC)
    ow.push(o.wall)
    oj.push(o.maxJit)
    const r = await measure(rustQ, CONC)
    rw.push(r.wall)
    rj.push(r.maxJit)
  }

  const os = stats(ow)
  const rs = stats(rw)
  const ojs = stats(oj)
  const rjs = stats(rj)

  console.log('=== WALL TIME for', CONC, 'concurrent queries (ms, lower=better) ===')
  console.log(`official  mean=${os.mean.toFixed(1)}  p50=${os.p50.toFixed(1)}  max=${os.max.toFixed(1)}`)
  console.log(`rust      mean=${rs.mean.toFixed(1)}  p50=${rs.p50.toFixed(1)}  max=${rs.max.toFixed(1)}`)
  const ratio = os.mean / rs.mean
  console.log(`rust ${ratio >= 1 ? `${ratio.toFixed(2)}x FASTER` : `${(1 / ratio).toFixed(2)}x SLOWER`}\n`)

  console.log('=== EVENT-LOOP MAX JITTER during queries (ms, lower=better) ===')
  console.log(`official  mean=${ojs.mean.toFixed(1)}  max=${ojs.max.toFixed(1)}`)
  console.log(`rust      mean=${rjs.mean.toFixed(1)}  max=${rjs.max.toFixed(1)}`)
  console.log('(lower jitter = event loop stayed responsive. Phase 3 off-thread parsing targets this.)')

  await ocoll.drop().catch(() => {})
  await official.close()
  await rust.close()
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
