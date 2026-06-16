// Phase 5 perf: rumongo Model vs Mongoose (hydrated) vs Mongoose .lean().
const mongoose = require('mongoose')
const { MongoClient } = require('../dist/index.js')
const { Model } = require('../dist/model.js')

const URI = 'mongodb://localhost:27017/?serverMonitoringMode=poll'
const DB = 'rumongo_bench', COLL = 'modelperf'
const N = Number(process.env.N || 50000), ITERS = Number(process.env.ITERS || 10)
const mean = (t) => t.reduce((a, b) => a + b, 0) / t.length

function makeDoc(i) { return { name: `u${i}`, age: 18 + (i % 60), email: `u${i}@x.com`, city: `c${i % 50}`, score: i % 100, active: i % 2 === 0 } }
async function timeIt(fn, iters) {
  const t = []
  for (let k = 0; k < iters; k++) { const s = process.hrtime.bigint(); await fn(); t.push(Number(process.hrtime.bigint() - s) / 1e6) }
  return mean(t)
}

async function main() {
  await mongoose.connect(URI, { dbName: DB })
  const User = mongoose.model('M', new mongoose.Schema(
    { name: String, age: Number, email: String, city: String, score: Number, active: Boolean },
    { collection: COLL, versionKey: false }))
  await User.deleteMany({})
  console.log(`seeding ${N}...`)
  for (let s = 0; s < N; s += 10000) await User.insertMany(Array.from({ length: Math.min(10000, N - s) }, (_, k) => makeDoc(s + k)))

  const client = await MongoClient.connect(URI)
  const Mx = Model.define(client.collection(DB, COLL), { name: 1, age: 1, email: 1, city: 1, score: 1, active: 1 })

  const hydrate = () => User.find()
  const lean = () => User.find().lean()
  const mx = () => Mx.find()

  for (const f of [hydrate, lean, mx]) await timeIt(f, 3) // warmup

  const h = await timeIt(hydrate, ITERS)
  const l = await timeIt(lean, ITERS)
  const m = await timeIt(mx, ITERS)
  console.log(`\n=== find ${N} docs, ${ITERS} iters (ms, lower=better) ===`)
  console.log(`mongoose (hydrated) : ${h.toFixed(1)}`)
  console.log(`mongoose (.lean)    : ${l.toFixed(1)}`)
  console.log(`rumongo Model     : ${m.toFixed(1)}`)
  console.log(`\nrumongo vs mongoose hydrated: ${(h / m).toFixed(1)}x | vs lean: ${(l / m).toFixed(1)}x`)

  await User.deleteMany({}); await mongoose.disconnect(); await client.close(); process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
