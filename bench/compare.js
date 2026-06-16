// Compare official mongodb Node driver vs rumongo (Phase 1).
// Reports PARITY (identical results) and PERF (wall time over N iterations).
// Phase 1 is unoptimized — expect it to LOSE on perf for now. This is the baseline.

const { MongoClient: Official } = require('mongodb')
const { MongoClient: Rust } = require('../index.js')

const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB = 'rumongo_bench'
const COLL = 'compare'
const N_DOCS = Number(process.env.N_DOCS || 10000)
const ITERS = Number(process.env.ITERS || 20)
const WARMUP = 3

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
    createdAt: new Date(1700000000000 + i * 1000),
  }
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b)
  const mean = times.reduce((a, b) => a + b, 0) / times.length
  const p50 = sorted[Math.floor(sorted.length * 0.5)]
  return { mean, p50, min: sorted[0], max: sorted[sorted.length - 1] }
}

async function timeIt(fn, iters) {
  const times = []
  for (let k = 0; k < iters; k++) {
    const t = process.hrtime.bigint()
    await fn()
    times.push(Number(process.hrtime.bigint() - t) / 1e6) // ms
  }
  return stats(times)
}

// normalize for parity: official returns ObjectId/Date objects; rust returns
// extended-JSON ({$oid},{$date}). Compare on stable, type-agnostic fields.
function normalize(doc) {
  return JSON.stringify({
    i: doc.i,
    name: doc.name,
    email: doc.email,
    age: doc.age,
    active: doc.active,
    score: doc.score,
    tags: doc.tags,
    address: doc.address,
  })
}

async function main() {
  console.log(`docs=${N_DOCS} iters=${ITERS} warmup=${WARMUP}\n`)

  const official = new Official(URI)
  await official.connect()
  const ocoll = official.db(DB).collection(COLL)

  console.log('seeding...')
  await ocoll.deleteMany({})
  const batch = Array.from({ length: N_DOCS }, (_, i) => makeDoc(i))
  await ocoll.insertMany(batch)

  const rust = await Rust.connect(URI)

  const officialFind = async () => {
    return ocoll.find({}).toArray()
  }
  const rustFind = async () => {
    const rows = await rust.find(DB, COLL, '{}', '{}')
    return rows.map((r) => JSON.parse(r))
  }

  // ---- PARITY ----
  const od = await officialFind()
  const rd = await rustFind()
  let parityOk = od.length === rd.length
  let firstDiff = -1
  if (parityOk) {
    const om = od.map(normalize).sort()
    const rm = rd.map(normalize).sort()
    for (let i = 0; i < om.length; i++) {
      if (om[i] !== rm[i]) {
        parityOk = false
        firstDiff = i
        break
      }
    }
  }
  console.log('=== PARITY ===')
  console.log(`official count: ${od.length}`)
  console.log(`rust count:     ${rd.length}`)
  console.log(`match: ${parityOk ? 'YES ✓' : `NO ✗ (first diff @${firstDiff})`}\n`)

  // ---- PERF ----
  await timeIt(officialFind, WARMUP)
  await timeIt(rustFind, WARMUP)
  const o = await timeIt(officialFind, ITERS)
  const r = await timeIt(rustFind, ITERS)

  console.log('=== PERF (ms, lower=better) ===')
  const row = (n, s) =>
    `${n.padEnd(10)} mean=${s.mean.toFixed(1)}  p50=${s.p50.toFixed(1)}  min=${s.min.toFixed(1)}  max=${s.max.toFixed(1)}`
  console.log(row('official', o))
  console.log(row('rust', r))
  const ratio = o.mean / r.mean
  console.log(
    `\nrust is ${ratio >= 1 ? `${ratio.toFixed(2)}x FASTER` : `${(1 / ratio).toFixed(2)}x SLOWER`} than official (by mean)`,
  )

  await ocoll.drop().catch(() => {})
  await official.close()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
