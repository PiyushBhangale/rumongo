// Worker-side entry for the rumongo worker pool.
// Loads the native addon, holds its own MongoClient, answers find requests.
// Runs on its OWN V8 isolate, so BSON->JS materialization here does not block
// the main event loop.

const { parentPort, workerData } = require('worker_threads')
const { MongoClient } = require('../index.js')

let client

async function handle(msg) {
  const { id, op, db, coll, filter, opts } = msg
  try {
    if (op === 'close') {
      if (client) await client.close()
      parentPort.postMessage({ id, ok: true })
      return
    }
    if (op === 'find') {
      // Return one JSON string per doc (same shape the addon returns). The
      // worker did the fetch + BSON decode on this isolate; main only receives.
      const rows = await client.find(db, coll, filter, opts)
      parentPort.postMessage({ id, rows })
      return
    }
    if (op === 'reduce') {
      // Generic "do the work in the worker" path: fetch + parse + run the
      // caller's reducer here, return only the accumulated result to main.
      // reducerSource is a function source string: (acc, doc) => acc
      const reducer = (0, eval)(`(${msg.reducerSource})`)
      const rows = await client.find(db, coll, filter, opts)
      let acc = msg.init
      for (const r of rows) acc = reducer(acc, JSON.parse(r))
      parentPort.postMessage({ id, acc, count: rows.length })
      return
    }
    parentPort.postMessage({ id, error: `unknown op ${op}` })
  } catch (e) {
    parentPort.postMessage({ id, error: e.message })
  }
}

;(async () => {
  client = await MongoClient.connect(workerData.uri)
  parentPort.on('message', handle)
  parentPort.postMessage({ ready: true })
})().catch((e) => parentPort.postMessage({ fatal: e.message }))
