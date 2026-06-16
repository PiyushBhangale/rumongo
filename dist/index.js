"use strict";
// Public TypeScript API for rumongo.
//   - find()      eager: returns plain JS objects (parsed from JSON strings)
//   - findLazy()  Phase 4: returns Proxy-wrapped RawDoc — fields parse on access
Object.defineProperty(exports, "__esModule", { value: true });
exports.LazyCursor = exports.Collection = exports.MongoClient = exports.deepEqual = exports.shadow = exports.Schema = exports.Model = exports.WorkerPool = void 0;
const index_1 = require("../index");
// Opt-in worker pool (see worker/pool.js). Re-exported as part of the public API.
var pool_1 = require("../worker/pool");
Object.defineProperty(exports, "WorkerPool", { enumerable: true, get: function () { return pool_1.WorkerPool; } });
// Mongoose-style Model + projection pushdown.
var model_1 = require("./model");
Object.defineProperty(exports, "Model", { enumerable: true, get: function () { return model_1.Model; } });
Object.defineProperty(exports, "Schema", { enumerable: true, get: function () { return model_1.Schema; } });
// Shadow mode (validate rumongo vs official in production).
var shadow_1 = require("./shadow");
Object.defineProperty(exports, "shadow", { enumerable: true, get: function () { return shadow_1.shadow; } });
Object.defineProperty(exports, "deepEqual", { enumerable: true, get: function () { return shadow_1.deepEqual; } });
// Wrap a RawDoc so `doc.field` parses just that field on demand, while spread
// (`{...doc}`) and JSON.stringify still see all fields (via ownKeys + descriptors).
function wrapRawDoc(doc) {
    return new Proxy(doc, {
        get(target, prop) {
            if (typeof prop !== 'string')
                return undefined;
            if (prop === 'toObject' || prop === 'toJSON')
                return () => target.toObject();
            if (prop === 'toString')
                return () => JSON.stringify(target.toObject());
            if (prop === '__isRawDoc')
                return true;
            if (prop === 'then')
                return undefined; // never look thenable
            return target.getField(prop);
        },
        has(target, prop) {
            return typeof prop === 'string' && target.keys().includes(prop);
        },
        ownKeys(target) {
            return target.keys();
        },
        getOwnPropertyDescriptor(target, prop) {
            if (typeof prop === 'string' && target.keys().includes(prop)) {
                return {
                    enumerable: true,
                    configurable: true,
                    value: target.getField(prop),
                };
            }
            return undefined;
        },
    });
}
class MongoClient {
    constructor(native) {
        this.native = native;
    }
    static async connect(uri, options) {
        const opts = options ? JSON.stringify(options) : undefined;
        return new MongoClient(await index_1.MongoClient.connect(uri, opts));
    }
    collection(db, name) {
        return new Collection(this.native, db, name);
    }
    async close() {
        await this.native.close();
    }
}
exports.MongoClient = MongoClient;
class Collection {
    constructor(native, db, name) {
        this.native = native;
        this.db = db;
        this.name = name;
    }
    /** Eager: fully parsed plain JS objects. */
    async find(filter = {}, options = {}) {
        const rows = await this.native.find(this.db, this.name, JSON.stringify(filter), JSON.stringify(options));
        return rows.map((r) => JSON.parse(r));
    }
    /** Lazy: fields parse only when read. Returns Proxy-wrapped documents. */
    async findLazy(filter = {}, options = {}) {
        const docs = await this.native.findLazy(this.db, this.name, JSON.stringify(filter), JSON.stringify(options));
        return docs.map(wrapRawDoc);
    }
    /** Streaming: pull one batch of (Proxy-wrapped) docs at a time. Bounded memory. */
    async findCursor(filter = {}, options = {}) {
        const cur = await this.native.findCursor(this.db, this.name, JSON.stringify(filter), JSON.stringify(options));
        return new LazyCursor(cur);
    }
}
exports.Collection = Collection;
/** Wraps the native cursor; each batch's docs are Proxy-wrapped for dot access. */
class LazyCursor {
    constructor(native) {
        this.native = native;
    }
    /** Next batch of docs, or null when exhausted. */
    async nextBatch() {
        const batch = await this.native.nextBatch();
        return batch === null ? null : batch.map(wrapRawDoc);
    }
    /** Async iterator over individual docs across all batches. */
    async *[Symbol.asyncIterator]() {
        let batch;
        while ((batch = await this.nextBatch()) !== null) {
            for (const d of batch)
                yield d;
        }
    }
}
exports.LazyCursor = LazyCursor;
