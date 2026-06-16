/** Structural deep-equality via canonical JSON (order-insensitive for objects). */
export declare function deepEqual(a: unknown, b: unknown): boolean;
export interface Divergence<T> {
    rust: T[];
    official: T[];
}
/**
 * Run both implementations concurrently. If results diverge, call `onDivergence`
 * (e.g. log/metric) but still return the official result. If rumongo throws, the
 * divergence callback gets the error and the official result is returned.
 */
export declare function shadow<T>(rustFn: () => Promise<T[]>, officialFn: () => Promise<T[]>, onDivergence: (info: Divergence<T> & {
    error?: unknown;
}) => void): Promise<T[]>;
