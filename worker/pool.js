// Main-side worker pool for rumongo.
// Spawns N Node worker threads (each loads the addon + its own MongoClient),
// round-robins requests, matches replies by id. Keeps the main event loop free
// of BSON->JS work for the queries it dispatches.

const { Worker } = require('worker_threads')
const path = require('path')

class WorkerPool {
  constructor() {
    this._workers = []
    this._next = 0
    this._seq = 0
    this._pending = new Map() // id -> {resolve, reject}
  }

  static async create({ uri, size = Math.max(2, require('os').cpus().length - 2) } = {}) {
    const pool = new WorkerPool()
    await Promise.all(
      Array.from({ length: size }, () => pool._spawn(uri)),
    )
    return pool
  }

  _spawn(uri) {
    return new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'pool-worker.js'), { workerData: { uri } })
      w.on('message', (msg) => {
        if (msg.ready) return resolve()
        if (msg.fatal) return reject(new Error(msg.fatal))
        const p = this._pending.get(msg.id)
        if (!p) return
        this._pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error))
        else p.resolve(msg)
      })
      w.on('error', reject)
      this._workers.push(w)
    })
  }

  _dispatch(payload) {
    const id = ++this._seq
    const w = this._workers[this._next++ % this._workers.length]
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      w.postMessage({ id, ...payload })
    })
  }

  /** find -> array of parsed JS objects (main parses the JSON strings). */
  async find(db, coll, filter = {}, opts = {}) {
    const msg = await this._dispatch({
      op: 'find',
      db,
      coll,
      filter: JSON.stringify(filter),
      opts: JSON.stringify(opts),
    })
    return msg.rows.map((r) => JSON.parse(r))
  }

  /**
   * Run a reducer over the query results INSIDE a worker; only the accumulated
   * result crosses back to main. The reducer must be a pure function with no
   * closure over main-thread state (it is shipped as source and rebuilt in the
   * worker): `(acc, doc) => acc`.
   *
   *   await pool.reduce('db','users', {active:true}, {}, (a,d)=>a+d.age, 0)
   */
  async reduce(db, coll, filter, opts, reducer, init) {
    const msg = await this._dispatch({
      op: 'reduce',
      db,
      coll,
      filter: JSON.stringify(filter || {}),
      opts: JSON.stringify(opts || {}),
      reducerSource: reducer.toString(),
      init,
    })
    return { acc: msg.acc, count: msg.count }
  }

  async close() {
    // Send a close to EACH worker (not round-robin), then terminate.
    await Promise.all(
      this._workers.map(
        (w) =>
          new Promise((resolve) => {
            const id = ++this._seq
            this._pending.set(id, { resolve, reject: resolve })
            w.postMessage({ id, op: 'close' })
          }),
      ),
    )
    await Promise.all(this._workers.map((w) => w.terminate()))
  }
}

module.exports = { WorkerPool }
