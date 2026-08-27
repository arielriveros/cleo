// Choosing the element-index width for a mesh upload. Pure and GL-free.

import type { IndexFormat } from './rhi/types';

/**
 * First index value `UNSIGNED_SHORT` cannot carry — 65535, not 65536: WebGL2 reserves the type's
 * maximum as the fixed primitive-restart marker.
 */
export const INDEX_16_LIMIT = 65535;

/** WebGL enum for 16-bit element indices. */
export const GL_UNSIGNED_SHORT = 0x1403;
/** WebGL enum for 32-bit element indices. */
export const GL_UNSIGNED_INT = 0x1405;

/**
 * Largest value in `indices`, or -1 for an empty array. Must stay an explicit loop —
 * `Math.max(...indices)` throws `RangeError` past roughly 125k elements.
 */
export function maxIndex(indices: ArrayLike<number>): number {
    let max = -1;
    for (let i = 0; i < indices.length; i++)
        if (indices[i] > max) max = indices[i];
    return max;
}

/** True when `indices` cannot be represented as 16-bit and must be uploaded as `UNSIGNED_INT`. */
export function needs32Bit(indices: ArrayLike<number>): boolean {
    return maxIndex(indices) >= INDEX_16_LIMIT;
}

/**
 * Narrowest typed array that represents `indices` losslessly: `Uint16Array`, or `Uint32Array` once any
 * index reaches {@link INDEX_16_LIMIT}.
 *
 * @throws If any index is negative, fractional or NaN.
 */
export function createIndexArray(indices: ArrayLike<number>): Uint16Array | Uint32Array {
    // A Uint32Array cannot hold a bad index by construction, so only plain arrays need the scan.
    if (!(indices instanceof Uint32Array)) {
        for (let i = 0; i < indices.length; i++) {
            const v = indices[i];
            if (!Number.isInteger(v) || v < 0)
                throw new Error(`createIndexArray: index ${i} is ${v}; expected a non-negative integer.`);
        }
    }
    if (!needs32Bit(indices)) return new Uint16Array(indices);
    return indices instanceof Uint32Array ? indices : new Uint32Array(indices);
}

/** The GL element type matching an array from {@link createIndexArray}. */
export function glTypeFor(array: Uint16Array | Uint32Array): number {
    return array instanceof Uint32Array ? GL_UNSIGNED_INT : GL_UNSIGNED_SHORT;
}

/** The backend-neutral index format matching an array from {@link createIndexArray}. */
export function indexFormatFor(array: Uint16Array | Uint32Array): IndexFormat {
    return array instanceof Uint32Array ? 'uint32' : 'uint16';
}
