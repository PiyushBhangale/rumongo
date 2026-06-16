"use strict";
// Shadow mode: run rumongo alongside the official driver, compare results, log
// divergences — but always return the official result. Lets you validate rumongo
// in production before cutover without risking responses.
Object.defineProperty(exports, "__esModule", { value: true });
exports.deepEqual = deepEqual;
exports.shadow = shadow;
/** Structural deep-equality via canonical JSON (order-insensitive for objects). */
function deepEqual(a, b) {
    return canon(a) === canon(b);
}
function canon(v) {
    return JSON.stringify(sortKeys(v));
}
// Normalize the official driver's rich BSON types to the Extended-JSON shapes
// rumongo emits, so equal DATA compares equal regardless of JS class:
//   ObjectId -> {$oid: hex},  Date -> {$date:{$numberLong: ms}}
function sortKeys(v) {
    if (v === null || typeof v !== 'object')
        return v;
    if (v instanceof Date)
        return { $date: { $numberLong: String(v.getTime()) } };
    const oid = v;
    if (typeof oid.toHexString === 'function' && oid._bsontype === 'ObjectId') {
        return { $oid: oid.toHexString() };
    }
    if (Array.isArray(v))
        return v.map(sortKeys);
    const o = v;
    const out = {};
    for (const k of Object.keys(o).sort())
        out[k] = sortKeys(o[k]);
    return out;
}
/**
 * Run both implementations concurrently. If results diverge, call `onDivergence`
 * (e.g. log/metric) but still return the official result. If rumongo throws, the
 * divergence callback gets the error and the official result is returned.
 */
async function shadow(rustFn, officialFn, onDivergence) {
    const [rustSettled, official] = await Promise.all([
        rustFn().then((r) => ({ ok: true, r }), (error) => ({ ok: false, error })),
        officialFn(),
    ]);
    if (!rustSettled.ok) {
        onDivergence({ rust: [], official, error: rustSettled.error });
        return official;
    }
    if (!deepEqual(rustSettled.r, official)) {
        onDivergence({ rust: rustSettled.r, official });
    }
    return official;
}
