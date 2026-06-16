// Phase 5 Model parity: rumongo Model vs Mongoose on identical data.
// Compares schema-field values + counts (ignoring _id/__v representation).

const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')

const mongoose = require('mongoose')
const { MongoClient } = require('../../dist/index.js')
const { Model } = require('../../dist/model.js')

const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/?serverMonitoringMode=poll'
const DB = 'rumongo_model'
const COLL = 'users'

let client
let coll
let UserMongoose
let UserMx

const pick = (d) => ({ name: d.name, age: d.age }) // schema fields only
const sortByAge = (a, b) => a.age - b.age

before(async () => {
  await mongoose.connect(URI, { dbName: DB })
  UserMongoose = mongoose.model(
    'User',
    new mongoose.Schema({ name: String, age: Number }, { collection: COLL, versionKey: false }),
  )
  client = await MongoClient.connect(URI)
  coll = client.collection(DB, COLL)
  UserMx = Model.define(coll, { name: 1, age: 1 })
})

after(async () => {
  await mongoose.connection.dropCollection(COLL).catch(() => {})
  await mongoose.disconnect()
  if (client) await client.close()
})

beforeEach(async () => {
  await UserMongoose.deleteMany({})
  await UserMongoose.insertMany([
    { name: 'Ann', age: 30 },
    { name: 'Bob', age: 25 },
    { name: 'Cy', age: 40 },
    { name: 'Di', age: 25 },
  ])
})

test('1 Model.find() returns all', async () => {
  const mg = (await UserMongoose.find().lean()).map(pick).sort(sortByAge)
  const mx = (await UserMx.find()).map(pick).sort(sortByAge)
  assert.deepStrictEqual(mx, mg)
})

test('2 Model.find() with filter', async () => {
  const mg = (await UserMongoose.find({ age: 25 }).lean()).map(pick).sort((a, b) => a.name.localeCompare(b.name))
  const mx = (await UserMx.find({ age: 25 })).map(pick).sort((a, b) => a.name.localeCompare(b.name))
  assert.deepStrictEqual(mx, mg)
})

test('3 Model.findOne()', async () => {
  const mg = await UserMongoose.findOne({ name: 'Cy' }).lean()
  const mx = await UserMx.findOne({ name: 'Cy' })
  assert.strictEqual(mx.name, mg.name)
  assert.strictEqual(mx.age, mg.age)
})

test('4 Model.findById()', async () => {
  const created = await UserMongoose.findOne({ name: 'Ann' }).lean()
  const id = created._id.toHexString()
  const mx = await UserMx.findById(id)
  assert.strictEqual(mx.name, 'Ann')
  assert.strictEqual(mx.age, 30)
})

test('5 Model.find() with sort', async () => {
  const mg = (await UserMongoose.find().sort({ age: 1 }).lean()).map(pick)
  const mx = (await UserMx.find({}, { sort: { age: 1 } })).map(pick)
  assert.deepStrictEqual(mx, mg)
})

test('6 Model.find() with limit', async () => {
  const mg = (await UserMongoose.find().sort({ age: 1 }).limit(2).lean()).map(pick)
  const mx = (await UserMx.find({}, { sort: { age: 1 }, limit: 2 })).map(pick)
  assert.deepStrictEqual(mx, mg)
})

test('7 projection pushdown: only schema fields returned', async () => {
  // insert a doc with an extra field NOT in the schema
  await UserMongoose.collection.insertOne({ name: 'Ex', age: 99, secret: 'hidden' })
  const [doc] = await UserMx.find({ name: 'Ex' })
  const keys = Object.keys(doc).sort()
  // _id always returned; schema fields name/age; NOT secret
  assert.ok(!keys.includes('secret'), `secret leaked: ${keys}`)
  assert.ok(keys.includes('name') && keys.includes('age'))
})

test('8 Model.find() on empty collection -> []', async () => {
  await UserMongoose.deleteMany({})
  const mx = await UserMx.find()
  assert.deepStrictEqual(mx, [])
})

test('9 Model.findOne() no match -> null', async () => {
  const mx = await UserMx.findOne({ name: 'Nobody' })
  assert.strictEqual(mx, null)
})
