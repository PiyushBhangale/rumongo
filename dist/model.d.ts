import { Collection } from './index';
export type SchemaDefinition = Record<string, unknown>;
export declare class Schema {
    readonly fields: string[];
    readonly projection: Record<string, 1>;
    constructor(definition: SchemaDefinition);
}
export interface QueryOptions {
    sort?: Record<string, 1 | -1>;
    limit?: number;
    skip?: number;
}
export declare class Model<T = Record<string, unknown>> {
    private readonly collection;
    private readonly schema;
    private constructor();
    /** Define a model over a collection from a schema definition. */
    static define<U = Record<string, unknown>>(collection: Collection, definition: SchemaDefinition): Model<U>;
    /** The cached projection MongoDB receives (schema fields only). */
    getProjection(): Record<string, 1>;
    /** find with the schema projection pushed down. */
    find(filter?: object, options?: QueryOptions): Promise<T[]>;
    /** First match, or null. */
    findOne(filter?: object, options?: QueryOptions): Promise<T | null>;
    /** Find by _id. Accepts a 24-char hex ObjectId string (Mongoose-style). */
    findById(id: string, options?: QueryOptions): Promise<T | null>;
}
