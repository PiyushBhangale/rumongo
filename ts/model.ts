// Phase 5 — Mongoose-style Model with projection pushdown.
//
// A Model wraps a Collection + a schema (field list). Every query automatically
// applies a projection of the schema fields, so MongoDB only sends the fields
// you defined — less wire data, less to parse. The projection is built once and
// cached.

import { Collection } from './index'

export type SchemaDefinition = Record<string, unknown>

export class Schema {
  readonly fields: string[]
  readonly projection: Record<string, 1>

  constructor(definition: SchemaDefinition) {
    this.fields = Object.keys(definition)
    this.projection = {}
    for (const f of this.fields) this.projection[f] = 1
  }
}

export interface QueryOptions {
  sort?: Record<string, 1 | -1>
  limit?: number
  skip?: number
}

export class Model<T = Record<string, unknown>> {
  private constructor(
    private readonly collection: Collection,
    private readonly schema: Schema,
  ) {}

  /** Define a model over a collection from a schema definition. */
  static define<U = Record<string, unknown>>(
    collection: Collection,
    definition: SchemaDefinition,
  ): Model<U> {
    return new Model<U>(collection, new Schema(definition))
  }

  /** The cached projection MongoDB receives (schema fields only). */
  getProjection(): Record<string, 1> {
    return this.schema.projection
  }

  /** find with the schema projection pushed down. */
  async find(filter: object = {}, options: QueryOptions = {}): Promise<T[]> {
    return this.collection.find<T>(filter, {
      ...options,
      projection: this.schema.projection,
    })
  }

  /** First match, or null. */
  async findOne(filter: object = {}, options: QueryOptions = {}): Promise<T | null> {
    const rows = await this.find(filter, { ...options, limit: 1 })
    return rows[0] ?? null
  }

  /** Find by _id. Accepts a 24-char hex ObjectId string (Mongoose-style). */
  async findById(id: string, options: QueryOptions = {}): Promise<T | null> {
    // Encode as Extended JSON so the Rust layer casts it to an ObjectId.
    return this.findOne({ _id: { $oid: id } } as object, options)
  }
}
