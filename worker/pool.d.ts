// Type declarations for the opt-in worker pool (worker/pool.js).

export interface WorkerPoolOptions {
  /** MongoDB connection string. */
  uri: string
  /** Number of worker threads. Default: cpus - 2 (min 2). */
  size?: number
}

/**
 * Opt-in pool of Node worker threads, each running the rumongo addon on its
 * own V8 isolate. Use `reduce` to run work in a worker and keep the main event
 * loop free. `find` returns rows to main (no jitter benefit — prefer the direct
 * client for that).
 */
export declare class WorkerPool {
  static create(opts: WorkerPoolOptions): Promise<WorkerPool>

  /** Query in a worker, return parsed rows to main (data crosses the boundary). */
  find<T = Record<string, unknown>>(
    db: string,
    coll: string,
    filter?: object,
    opts?: object,
  ): Promise<T[]>

  /**
   * Run a reducer over the query results INSIDE a worker; only the accumulator
   * crosses back to main. The reducer is shipped as source, so it must be pure
   * (no closure over main-thread variables): `(acc, doc) => acc`.
   */
  reduce<A>(
    db: string,
    coll: string,
    filter: object,
    opts: object,
    reducer: (acc: A, doc: Record<string, unknown>) => A,
    init: A,
  ): Promise<{ acc: A; count: number }>

  close(): Promise<void>
}
