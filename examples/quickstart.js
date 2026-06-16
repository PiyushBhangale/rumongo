// rumongo quickstart. Run: node examples/quickstart.js
// (rumongo is read-only, so we seed with the official driver first.)

const { MongoClient: Official } = require('mongodb')
// The public rumongo API (compiled from ts/ -> dist/ via `npm run build:ts`).
const { MongoClient, Model, shadow } = require('../dist/index.js')

const URI = 'mongodb://localhost:27017'
const DB = 'demo', COLL = 'users'

async function main() {
  // --- seed some data (use the official driver / your app for writes) ---
  const off = new Official(URI)
  await off.connect()
  const c = off.db(DB).collection(COLL)
  await c.deleteMany({})
  await c.insertMany([
    { name: 'Ann', age: 30, city: 'NYC', bio: 'x'.repeat(50) },
    { name: 'Bob', age: 25, city: 'LA', bio: 'y'.repeat(50) },
    { name: 'Cy', age: 40, city: 'SF', bio: 'z'.repeat(50) },
  ])

  // --- connect rumongo (pass pool/timeout options if you want) ---
  const client = await MongoClient.connect(URI, { maxPoolSize: 20 })
  const users = client.collection(DB, COLL)

  // 1) eager find -> plain objects
  const adults = await users.find({ age: { $gte: 30 } }, { sort: { age: 1 } })
  console.log('1) find adults:', adults.map((u) => `${u.name}(${u.age})`))

  // 2) lazy find -> only the fields you touch get parsed (skips the big `bio`)
  const lazy = await users.findLazy({}, { sort: { age: 1 } })
  console.log('2) lazy names:', lazy.map((d) => d.name))

  // 3) streaming cursor -> bounded memory for big results
  const cur = await users.findCursor({}, { batchSize: 2 })
  let total = 0, batch
  while ((batch = await cur.nextBatch()) !== null) total += batch.length
  console.log('3) cursor streamed:', total, 'docs')

  // 4) Mongoose-style Model with projection pushdown (only name+age fetched)
  const User = Model.define(users, { name: 1, age: 1 })
  console.log('4) Model.findOne:', await User.findOne({ name: 'Bob' }))

  // 5) shadow mode (compare vs official, return official, log divergence)
  const safe = await shadow(
    () => users.find({ city: 'SF' }),
    () => c.find({ city: 'SF' }).toArray(),
    (diff) => console.log('   divergence!', diff),
  )
  console.log('5) shadow (returns official):', safe.map((u) => u.name))

  // --- always close: stops Rust background monitors so Node can exit ---
  await client.close()
  await c.drop().catch(() => {})
  await off.close()
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
