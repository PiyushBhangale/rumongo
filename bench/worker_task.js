// Worker thread: loads the native addon and runs heavy queries here, so all
// BSON->JS materialization happens on THIS isolate's loop, not the main one.
const { parentPort, workerData } = require('worker_threads')
const { MongoClient } = require('../index.js')

const { uri, db, coll, conc } = workerData

;(async () => {
  const rust = await MongoClient.connect(uri)
  const run = async () => {
    const docs = await rust.findLazy(db, coll, '{}', '{}')
    let acc = 0
    for (const d of docs) acc += d.getField('i')
    return acc
  }
  // signal ready, then wait for "go" messages; each runs `conc` queries
  parentPort.on('message', async (msg) => {
    if (msg === 'stop') {
      await rust.close()
      parentPort.postMessage({ done: 'stopped' })
      return
    }
    const t0 = Date.now()
    await Promise.all(Array.from({ length: conc }, run))
    parentPort.postMessage({ done: 'batch', ms: Date.now() - t0 })
  })
  parentPort.postMessage({ ready: true })
})().catch((e) => parentPort.postMessage({ error: e.message }))
