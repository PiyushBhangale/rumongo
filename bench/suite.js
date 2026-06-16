// Phase 6 — consolidated, deterministic benchmark suite.
// Sweeps projection presets (few/small/medium/large/full) and reports:
//   A) driver find:  official Node driver vs rumongo (eager)
//   B) ODM:          mongoose .lean() vs rumongo Model
//   plus event-loop jitter on the heaviest preset.
//
// Deterministic: data is a pure function of the index (no randomness); warmup +
// N iters; reports mean ± stddev. Runs against local MongoDB (network ~0 here,
// so this isolates client-side cost without a mock wire server).

const mongoose = require('mongoose')
const { MongoClient } = require('../dist/index.js')
const { Model } = require('../dist/model.js')

const URI = 'mongodb://localhost:27017/?serverMonitoringMode=poll'
const DB = 'rumongo_suite', COLL = 'docs'
const N = Number(process.env.N || 30000)
const ITERS = Number(process.env.ITERS || 6)
const WARMUP = 2

// 45 fields total: scalars + nested + array, deterministic by index.
const SCALARS = []
for (let k = 0; k < 40; k++) SCALARS.push(`f${k}`)
const FIELDS = ['idx', 'name', 'email', 'address', 'tags', ...SCALARS] // 45

function fullDoc(i) {
  const d = {
    idx: i,
    name: `user-${i}`,
    email: `user-${i}@example.com`,
    address: { city: `city-${i % 100}`, zip: 10000 + (i % 9000), geo: { lat: i % 90, lng: i % 180 } },
    tags: [`t${i % 5}`, `t${i % 7}`, `t${i % 11}`],
  }
  for (let k = 0; k < 40; k++) d[`f${k}`] = `v-${i}-${k}`
  return d
}

const PRESETS = {
  few: FIELDS.slice(0, 4),
  small: FIELDS.slice(0, 9),
  medium: FIELDS.slice(0, 15),
  large: FIELDS.slice(0, 35),
  full: FIELDS.slice(0, 45),
}
const projOf = (fields) => { const p = {}; for (const f of fields) p[f] = 1; return p }

function stats(t) {
  const m = t.reduce((a, b) => a + b, 0) / t.length
  const sd = Math.sqrt(t.reduce((a, b) => a + (b - m) ** 2, 0) / t.length)
  return { mean: m, sd }
}
async function timeIt(fn, iters) {
  const t = []
  for (let k = 0; k < iters; k++) { const s = process.hrtime.bigint(); await fn(); t.push(Number(process.hrtime.bigint() - s) / 1e6) }
  return stats(t)
}
async function jitterOf(fn) {
  const j = []; let last = process.hrtime.bigint()
  const tm = setInterval(() => { const n = process.hrtime.bigint(); j.push(Number(n - last) / 1e6 - 10); last = n }, 10)
  await fn(); clearInterval(tm)
  return j.length ? Math.max(...j) : 0
}

async function main() {
  await mongoose.connect(URI, { dbName: DB })
  const official = mongoose.connection.getClient()
  const ocoll = official.db(DB).collection(COLL)
  console.log(`N=${N} iters=${ITERS} (mean±sd ms)\nseeding...`)
  await ocoll.deleteMany({})
  for (let s = 0; s < N; s += 10000) {
    await ocoll.insertMany(Array.from({ length: Math.min(10000, N - s) }, (_, k) => fullDoc(s + k)))
  }

  const rumongo = await MongoClient.connect(URI)
  const rcoll = rumongo.collection(DB, COLL)

  // mongoose loose schema (Mixed) for ODM comparison
  const mSchema = new mongoose.Schema({}, { strict: false, collection: COLL, versionKey: false })
  const MUser = mongoose.model('Suite', mSchema)

  const fmt = (s) => `${s.mean.toFixed(1).padStart(7)}±${s.sd.toFixed(0)}`

  console.log('\n=== A) DRIVER find (official vs rumongo) ===')
  console.log('preset  | fields | official | rumongo | speedup')
  console.log('--------|--------|----------|---------|--------')
  for (const [name, fields] of Object.entries(PRESETS)) {
    const proj = projOf(fields)
    const off = () => ocoll.find({}, { projection: proj }).toArray()
    const ru = () => rcoll.find({}, { projection: proj })
    await timeIt(off, WARMUP); await timeIt(ru, WARMUP)
    const o = await timeIt(off, ITERS), r = await timeIt(ru, ITERS)
    console.log(`${name.padEnd(7)} | ${String(fields.length).padStart(6)} | ${fmt(o)} | ${fmt(r)} | ${(o.mean / r.mean).toFixed(2)}x`)
  }

  console.log('\n=== B) ODM (mongoose .lean vs rumongo Model) ===')
  console.log('preset  | fields | mongoose | Model   | speedup')
  console.log('--------|--------|----------|---------|--------')
  for (const [name, fields] of Object.entries(PRESETS)) {
    const proj = projOf(fields)
    const Mx = Model.define(rcoll, proj)
    const mg = () => MUser.find({}, proj).lean()
    const mx = () => Mx.find()
    await timeIt(mg, WARMUP); await timeIt(mx, WARMUP)
    const m = await timeIt(mg, ITERS), x = await timeIt(mx, ITERS)
    console.log(`${name.padEnd(7)} | ${String(fields.length).padStart(6)} | ${fmt(m)} | ${fmt(x)} | ${(m.mean / x.mean).toFixed(2)}x`)
  }

  console.log('\n=== C) event-loop jitter on FULL preset (single query) ===')
  const proj = projOf(PRESETS.full)
  const oJit = await jitterOf(() => ocoll.find({}, { projection: proj }).toArray())
  const rJit = await jitterOf(() => rcoll.find({}, { projection: proj }))
  console.log(`official maxJitter=${oJit.toFixed(1)}ms | rumongo maxJitter=${rJit.toFixed(1)}ms`)

  await ocoll.drop().catch(() => {})
  await mongoose.disconnect()
  await rumongo.close()
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
