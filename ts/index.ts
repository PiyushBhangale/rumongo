// Public TypeScript API for rumongo.
//   - find()      eager: returns plain JS objects (parsed from JSON strings)
//   - findLazy()  Phase 4: returns Proxy-wrapped RawDoc — fields parse on access

import { MongoClient as NativeClient, RawDoc, FindCursor as NativeCursor } from '../index'

// Opt-in worker pool (see worker/pool.js). Re-exported as part of the public API.
export { WorkerPool } from '../worker/pool'
export type { WorkerPoolOptions } from '../worker/pool'

// Mongoose-style Model + projection pushdown.
export { Model, Schema } from './model'
export type { SchemaDefinition, QueryOptions } from './model'

// Shadow mode (validate rumongo vs official in production).
export { shadow, deepEqual } from './shadow'
export type { Divergence } from './shadow'

// Wrap a RawDoc so `doc.field` parses just that field on demand, while spread
// (`{...doc}`) and JSON.stringify still see all fields (via ownKeys + descriptors).
function wrapRawDoc(doc: RawDoc): Record<string, unknown> {
  return new Proxy(doc as unknown as Record<string, unknown>, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop === 'toObject' || prop === 'toJSON') return () => (target as unknown as RawDoc).toObject()
      if (prop === 'toString') return () => JSON.stringify((target as unknown as RawDoc).toObject())
      if (prop === '__isRawDoc') return true
      if (prop === 'then') return undefined // never look thenable
      return (target as unknown as RawDoc).getField(prop)
    },
    has(target, prop) {
      return typeof prop === 'string' && (target as unknown as RawDoc).keys().includes(prop)
    },
    ownKeys(target) {
      return (target as unknown as RawDoc).keys()
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && (target as unknown as RawDoc).keys().includes(prop)) {
        return {
          enumerable: true,
          configurable: true,
          value: (target as unknown as RawDoc).getField(prop),
        }
      }
      return undefined
    },
  }) as unknown as Record<string, unknown>
}

export interface ConnectOptions {
  maxPoolSize?: number
  minPoolSize?: number
  connectTimeoutMs?: number
  serverSelectionTimeoutMs?: number
  appName?: string
}

export class MongoClient {
  private constructor(private readonly native: NativeClient) {}

  static async connect(uri: string, options?: ConnectOptions): Promise<MongoClient> {
    const opts = options ? JSON.stringify(options) : undefined
    return new MongoClient(await NativeClient.connect(uri, opts))
  }

  collection(db: string, name: string): Collection {
    return new Collection(this.native, db, name)
  }

  async close(): Promise<void> {
    await this.native.close()
  }
}

export class Collection {
  constructor(
    private readonly native: NativeClient,
    private readonly db: string,
    private readonly name: string,
  ) {}

  /** Eager: fully parsed plain JS objects. */
  async find<T = Record<string, unknown>>(
    filter: object = {},
    options: object = {},
  ): Promise<T[]> {
    const rows = await this.native.find(
      this.db,
      this.name,
      JSON.stringify(filter),
      JSON.stringify(options),
    )
    return rows.map((r: string) => JSON.parse(r) as T)
  }

  /** Lazy: fields parse only when read. Returns Proxy-wrapped documents. */
  async findLazy(filter: object = {}, options: object = {}): Promise<Record<string, unknown>[]> {
    const docs = await this.native.findLazy(
      this.db,
      this.name,
      JSON.stringify(filter),
      JSON.stringify(options),
    )
    return docs.map(wrapRawDoc)
  }

  /** Streaming: pull one batch of (Proxy-wrapped) docs at a time. Bounded memory. */
  async findCursor(filter: object = {}, options: object = {}): Promise<LazyCursor> {
    const cur = await this.native.findCursor(
      this.db,
      this.name,
      JSON.stringify(filter),
      JSON.stringify(options),
    )
    return new LazyCursor(cur)
  }
}

/** Wraps the native cursor; each batch's docs are Proxy-wrapped for dot access. */
export class LazyCursor {
  constructor(private readonly native: NativeCursor) {}

  /** Next batch of docs, or null when exhausted. */
  async nextBatch(): Promise<Record<string, unknown>[] | null> {
    const batch = await this.native.nextBatch()
    return batch === null ? null : batch.map(wrapRawDoc)
  }

  /** Async iterator over individual docs across all batches. */
  async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>> {
    let batch
    while ((batch = await this.nextBatch()) !== null) {
      for (const d of batch) yield d
    }
  }
}
