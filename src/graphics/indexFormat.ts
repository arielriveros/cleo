// Choosing the element-index width for a mesh upload.
//
// This is deliberately its own module rather than a static on Mesh: mesh.ts imports the live `gl` from
// renderer.ts at module scope, so anything that reaches Mesh drags the whole WebGL graph in with it. Kept
// standalone and pure, this is directly unit-testable under vitest's node environment like the rest of the
// tested core (base64, bvh, convexHull).
//
// Every caller in the engine passes indices as plain `number[]` — JS numbers, so values are lossless right
// up to the GL boundary. The engine used to unconditionally do `new Uint16Array(indices)` there, which
// silently wraps: index 70000 became 4464 and any mesh over 65535 vertices rendered as scrambled
// triangles with nothing logged. The glTF loader had already decoded 32-bit indices correctly; the data
// was only destroyed on upload.

/**
 * First index value that `UNSIGNED_SHORT` cannot carry — 65535, not 65536.
 *
 * WebGL2 behaves as though `PRIMITIVE_RESTART_FIXED_INDEX` were always enabled, and the restart index is
 * fixed to the maximum value of the index type (`2^16 - 1` for `UNSIGNED_SHORT`). So 65535 is a
 * "start a new primitive here" marker rather than a vertex reference, and a mesh that used it as a real
 * index would silently drop every triangle touching its last vertex — the same class of invisible
 * corruption this module exists to prevent. Treating it as out of range costs one vertex of headroom.
 */
export const INDEX_16_LIMIT = 65535;

/** WebGL enum for 16-bit element indices. Fixed by the spec, so it needs no live context. */
export const GL_UNSIGNED_SHORT = 0x1403;
/** WebGL enum for 32-bit element indices. Core in WebGL2 — no extension required. */
export const GL_UNSIGNED_INT = 0x1405;

/**
 * Largest value in `indices`, or -1 for an empty array.
 *
 * Uses an explicit loop rather than `Math.max(...indices)` on purpose: the spread form throws
 * `RangeError: too many function arguments` somewhere around 125k elements, which is precisely the
 * large-mesh case this module is here to support. Do not "simplify" it back.
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
 * Narrowest typed array that represents `indices` losslessly: `Uint16Array` for ordinary meshes,
 * `Uint32Array` once any index reaches {@link INDEX_16_LIMIT}. Keeping the common path 16-bit avoids
 * doubling index memory for the meshes that never needed 32-bit in the first place.
 *
 * @throws If any index is negative, fractional or NaN. These are always caller bugs, and silence is the
 *         worse outcome: `new Uint16Array([-1])` yields 65535 — which is also the primitive-restart index
 *         — so bad input currently corrupts geometry with no diagnostic. This runs once per upload, not
 *         per frame, so the scan is free in context.
 */
export function createIndexArray(indices: ArrayLike<number>): Uint16Array | Uint32Array {
    // A Uint32Array cannot hold a negative, fractional or NaN index by construction, so the scan is
    // only meaningful for plain arrays — and skipping it matters because Geometry now stores indices
    // as Uint32Array and this runs on every upload.
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
