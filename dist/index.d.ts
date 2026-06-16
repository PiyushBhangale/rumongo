import { MongoClient as NativeClient, FindCursor as NativeCursor } from '../index';
export { WorkerPool } from '../worker/pool';
export type { WorkerPoolOptions } from '../worker/pool';
export { Model, Schema } from './model';
export type { SchemaDefinition, QueryOptions } from './model';
export { shadow, deepEqual } from './shadow';
export type { Divergence } from './shadow';
export interface ConnectOptions {
    maxPoolSize?: number;
    minPoolSize?: number;
    connectTimeoutMs?: number;
    serverSelectionTimeoutMs?: number;
    appName?: string;
}
export declare class MongoClient {
    private readonly native;
    private constructor();
    static connect(uri: string, options?: ConnectOptions): Promise<MongoClient>;
    collection(db: string, name: string): Collection;
    close(): Promise<void>;
}
export declare class Collection {
    private readonly native;
    private readonly db;
    private readonly name;
    constructor(native: NativeClient, db: string, name: string);
    /** Eager: fully parsed plain JS objects. */
    find<T = Record<string, unknown>>(filter?: object, options?: object): Promise<T[]>;
    /** Lazy: fields parse only when read. Returns Proxy-wrapped documents. */
    findLazy(filter?: object, options?: object): Promise<Record<string, unknown>[]>;
    /** Streaming: pull one batch of (Proxy-wrapped) docs at a time. Bounded memory. */
    findCursor(filter?: object, options?: object): Promise<LazyCursor>;
}
/** Wraps the native cursor; each batch's docs are Proxy-wrapped for dot access. */
export declare class LazyCursor {
    private readonly native;
    constructor(native: NativeCursor);
    /** Next batch of docs, or null when exhausted. */
    nextBatch(): Promise<Record<string, unknown>[] | null>;
    /** Async iterator over individual docs across all batches. */
    [Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>>;
}
