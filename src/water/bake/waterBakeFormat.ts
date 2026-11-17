import { tileWaterInfo, type WaterInfo } from '../waterInfo';

// The bytes of a Water bake (`.cwtr`): a baked water info grid and the signature of what it was baked
// from. Stored, published and exported like a GI Volume's capture: the node names it by `bakeId`, and the
// bytes live in the bake registry (graphics/render/gi/giBakeRegistry.ts, which holds every kind of bake by
// id), filled from the project's storage or the game's data before any scene is parsed.
//
// Layout, little-endian: "CWTR", u32 version, u32 nx, u32 nz, f64 originX, f64 originZ, f64 cell,
// f64 oceanLevel (NaN = none), u32 signature bytes + UTF-8 signature, padding to 4, then info0 and info1
// as f32 (nx * nz * 4 each).

export const WATER_BAKE_MAGIC = 0x52545743;   // "CWTR"
export const WATER_BAKE_VERSION = 1;

export function encodeWaterBake(info: WaterInfo, signature: string): Uint8Array {
    const sig = new TextEncoder().encode(signature);
    const head = 4 + 4 + 4 + 4 + 8 * 4 + 4 + sig.length;
    const pad = (4 - (head % 4)) % 4;
    const n = info.nx * info.nz * 4;
    const bytes = new Uint8Array(head + pad + n * 8);
    const dv = new DataView(bytes.buffer);
    let o = 0;
    dv.setUint32(o, WATER_BAKE_MAGIC, true); o += 4;
    dv.setUint32(o, WATER_BAKE_VERSION, true); o += 4;
    dv.setUint32(o, info.nx, true); o += 4;
    dv.setUint32(o, info.nz, true); o += 4;
    dv.setFloat64(o, info.originX, true); o += 8;
    dv.setFloat64(o, info.originZ, true); o += 8;
    dv.setFloat64(o, info.cell, true); o += 8;
    dv.setFloat64(o, info.oceanLevel ?? NaN, true); o += 8;
    dv.setUint32(o, sig.length, true); o += 4;
    bytes.set(sig, o); o += sig.length + pad;
    new Float32Array(bytes.buffer, o, n).set(info.info0.subarray(0, n)); o += n * 4;
    new Float32Array(bytes.buffer, o, n).set(info.info1.subarray(0, n));
    return bytes;
}

/** The bake in `bytes`, or null when they are not one (another kind of bake, a newer version, truncated). */
export function decodeWaterBake(bytes: Uint8Array, id = 'bake'): { info: WaterInfo; signature: string } | null {
    if (!bytes || bytes.byteLength < 56) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = 0;
    if (dv.getUint32(o, true) !== WATER_BAKE_MAGIC) return null; o += 4;
    if (dv.getUint32(o, true) !== WATER_BAKE_VERSION) return null; o += 4;
    const nx = dv.getUint32(o, true); o += 4;
    const nz = dv.getUint32(o, true); o += 4;
    const originX = dv.getFloat64(o, true); o += 8;
    const originZ = dv.getFloat64(o, true); o += 8;
    const cell = dv.getFloat64(o, true); o += 8;
    const ocean = dv.getFloat64(o, true); o += 8;
    const sigLen = dv.getUint32(o, true); o += 4;
    if (o + sigLen > bytes.byteLength) return null;
    const signature = new TextDecoder().decode(bytes.subarray(o, o + sigLen));
    o += sigLen; o += (4 - (o % 4)) % 4;
    const n = nx * nz * 4;
    if (o + n * 8 > bytes.byteLength || !(nx > 0 && nz > 0)) return null;
    // Copied out: the registry's buffer may not be 4-aligned at its byteOffset.
    const floats = new Float32Array(bytes.slice(o, o + n * 8).buffer);
    const info0 = floats.slice(0, n), info1 = floats.slice(n, 2 * n);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i += 4) if (info1[i + 3] > 0.5) { minY = Math.min(minY, info0[i]); maxY = Math.max(maxY, info0[i]); }
    if (!Number.isFinite(minY)) { minY = 0; maxY = 0; }
    const info: WaterInfo = {
        originX, originZ, cell, nx, nz, info0, info1, minY, maxY,
        tileCells: 0, tilesX: 0, tilesZ: 0, tileWet: new Uint8Array(0), tileMinY: new Float32Array(0), tileMaxY: new Float32Array(0),
        oceanLevel: Number.isNaN(ocean) ? null : ocean, source: id,
    };
    tileWaterInfo(info);
    return { info, signature };
}

/** A fresh bake id. */
export function newWaterBakeId(): string {
    return `water-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
