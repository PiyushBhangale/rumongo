"use strict";
// Phase 5 — Mongoose-style Model with projection pushdown.
//
// A Model wraps a Collection + a schema (field list). Every query automatically
// applies a projection of the schema fields, so MongoDB only sends the fields
// you defined — less wire data, less to parse. The projection is built once and
// cached.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Model = exports.Schema = void 0;
class Schema {
    constructor(definition) {
        this.fields = Object.keys(definition);
        this.projection = {};
        for (const f of this.fields)
            this.projection[f] = 1;
    }
}
exports.Schema = Schema;
class Model {
    constructor(collection, schema) {
        this.collection = collection;
        this.schema = schema;
    }
    /** Define a model over a collection from a schema definition. */
    static define(collection, definition) {
        return new Model(collection, new Schema(definition));
    }
    /** The cached projection MongoDB receives (schema fields only). */
    getProjection() {
        return this.schema.projection;
    }
    /** find with the schema projection pushed down. */
    async find(filter = {}, options = {}) {
        return this.collection.find(filter, {
            ...options,
            projection: this.schema.projection,
        });
    }
    /** First match, or null. */
    async findOne(filter = {}, options = {}) {
        const rows = await this.find(filter, { ...options, limit: 1 });
        return rows[0] ?? null;
    }
    /** Find by _id. Accepts a 24-char hex ObjectId string (Mongoose-style). */
    async findById(id, options = {}) {
        // Encode as Extended JSON so the Rust layer casts it to an ObjectId.
        return this.findOne({ _id: { $oid: id } }, options);
    }
}
exports.Model = Model;
