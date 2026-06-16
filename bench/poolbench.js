// Sweep the worker pool across loads vs direct (main-thread) usage.
// For each load: total wall time + main-loop jitter.
//   direct       : main calls addon, parses, sums      (data lands on main)
//   pool-data    : worker queries, returns rows, main parses+sums (transfer cost)
//   pool-reduced : worker queries+sums, returns number  (tiny transfer)

const os = require('os')
const { MongoClient } = require('../index.js')
const { WorkerPool } = require('../worker/pool.js')

const URI = 'mongodb://localhost:27017/?serverMonitoringMode=poll'
const DB = 'rumongo_bench', COLL = 'pool'
const FIELDS = 20
const POOL = Number(process.env.POOL || Math.max(2, os.cpus().length - 2))

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
  return { wall, jit: j.length ? maxOf(j) : 0 }
}
async function run(fn, conc, iters = 5) {
  await measure(fn, conc)
  const w = [], jj = []
  for (let k = 0; k < iters; k++) { const m = await measure(fn, conc); w.push(m.wall); jj.push(m.jit) }
  return { wall: mean(w), jit: maxOf(jj) }
}

async function main() {
  const official = require('mongodb')
  const oc = new official.MongoClient(URI); await oc.connect()
  const ocoll = oc.db(DB).collection(COLL)
  const SEED = Number(process.env.SEED || 100000)
  console.log(`pool size=${POOL}, fields=${FIELDS}\nseeding ${SEED} docs...`)
  await ocoll.deleteMany({})
  for (let s = 0; s < SEED; s += 10000) {
    await ocoll.insertMany(Array.from({ length: Math.min(10000, SEED - s) }, (_, k) => makeDoc(s + k)))
  }

  const direct = await MongoClient.connect(URI)
  const pool = await WorkerPool.create({ uri: URI, size: POOL })

  // limit query to `n` docs via limit option
  const loads = [
    { name: 'small (100)', n: 100, conc: 20 },
    { name: 'med   (1000)', n: 1000, conc: 12 },
    { name: 'heavy (10000)', n: 10000, conc: 6 },
    { name: 'huge  (50000)', n: 50000, conc: 4 },
    { name: 'max   (100000)', n: 100000, conc: 2 },
  ]

  const directQ = (n) => async () => {
    const rows = await direct.find(DB, COLL, '{}', JSON.stringify({ limit: n }))
    let a = 0; for (const r of rows) a += JSON.parse(r).i; return a
  }
  const poolDataQ = (n) => async () => {
    const rows = await pool.find(DB, COLL, {}, { limit: n })
    let a = 0; for (const d of rows) a += d.i; return a
  }
  const poolRedQ = (n) => () => pool.reduce(DB, COLL, {}, { limit: n }, (a, d) => a + d.i, 0)

  console.log('\nload                | mode         |   wall ms | jitter ms')
  console.log('--------------------|--------------|-----------|----------')
  for (const L of loads) {
    const d = await run(directQ(L.n), L.conc)
    const pd = await run(poolDataQ(L.n), L.conc)
    const pr = await run(poolRedQ(L.n), L.conc)
    const row = (mode, r) => `${L.name.padEnd(19)} | ${mode.padEnd(12)} | ${r.wall.toFixed(1).padStart(9)} | ${r.jit.toFixed(1).padStart(8)}`
    console.log(row('direct', d))
    console.log(row('pool-data', pd))
    console.log(row('pool-reduced', pr))
    console.log('--------------------|--------------|-----------|----------')
  }

  await ocoll.drop().catch(() => {})
  await direct.close(); await pool.close(); await oc.close()
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
