// Phase 2 bench: sequential fetch+serialize vs pipelined.
// Same Rust binary, toggled via the `pipeline` option.

const { MongoClient: Official } = require('mongodb')
const { MongoClient: Rust } = require('../index.js')

const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB = 'rumongo_bench'
const COLL = 'pipeline'
const N_DOCS = Number(process.env.N_DOCS || 50000)
const ITERS = Number(process.env.ITERS || 15)
const WARMUP = 3
const BATCH = Number(process.env.BATCH || 1000)

function makeDoc(i) {
  return {
    i,
    name: `user-${i}`,
    email: `user-${i}@example.com`,
    age: 18 + (i % 60),
    active: i % 2 === 0,
    tags: [`t${i % 5}`, `t${i % 7}`],
    address: { city: `city-${i % 50}`, zip: 10000 + (i % 9000) },
  }
}

function stats(t) {
  const s = [...t].sort((a, b) => a - b)
  return {
    mean: t.reduce((a, b) => a + b, 0) / t.length,
    p50: s[Math.floor(s.length / 2)],
    min: s[0],
    max: s[s.length - 1],
  }
}

async function timeIt(fn, iters) {
  const times = []
  for (let k = 0; k < iters; k++) {
    const t = process.hrtime.bigint()
    await fn()
    times.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  return stats(times)
}

async function main() {
  console.log(`docs=${N_DOCS} iters=${ITERS} batchSize=${BATCH}\n`)
  const official = new Official(URI)
  await official.connect()
  const ocoll = official.db(DB).collection(COLL)
  console.log('seeding...')
  await ocoll.deleteMany({})
  await ocoll.insertMany(Array.from({ length: N_DOCS }, (_, i) => makeDoc(i)))

  const rust = await Rust.connect(URI)

  const seq = async () => {
    const r = await rust.find(DB, COLL, '{}', JSON.stringify({ pipeline: false, batchSize: BATCH }))
    return r.length
  }
  const pipe = async () => {
    const r = await rust.find(DB, COLL, '{}', JSON.stringify({ pipeline: true, batchSize: BATCH }))
    return r.length
  }

  // sanity: both return all docs
  const a = await seq()
  const b = await pipe()
  console.log(`counts: seq=${a} pipe=${b} (expect ${N_DOCS})\n`)

  await timeIt(seq, WARMUP)
  await timeIt(pipe, WARMUP)
  const s = await timeIt(seq, ITERS)
  const p = await timeIt(pipe, ITERS)

  const row = (n, x) => `${n.padEnd(12)} mean=${x.mean.toFixed(1)}  p50=${x.p50.toFixed(1)}  min=${x.min.toFixed(1)}  max=${x.max.toFixed(1)}`
  console.log('=== PERF (ms, lower=better) ===')
  console.log(row('sequential', s))
  console.log(row('pipelined', p))
  const imp = (s.mean - p.mean) / s.mean * 100
  console.log(`\npipelined ${imp >= 0 ? `${imp.toFixed(1)}% FASTER` : `${(-imp).toFixed(1)}% SLOWER`} than sequential`)

  await ocoll.drop().catch(() => {})
  await official.close()
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
