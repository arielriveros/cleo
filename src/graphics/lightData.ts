import type { ClusterBuild } from './clusters';
import { LTC_TABLE_1_HALF_BASE64, LTC_TABLE_2_HALF_BASE64, LTC_TABLE_SIZE } from './ltcTables';

// -----------------------------------------------------------------------------------------------
// The light data texture: one rgba32float 2D texture carrying the cluster table, the packed light
// index list, and the light records themselves.
//
// A UNIFORM BLOCK IS THE WRONG HOME FOR THIS, which is what the four `array<PointLight, 16>`
// declarations this replaces were. ES 3.0 guarantees only 16 KB for `MAX_UNIFORM_BLOCK_SIZE` — about
// 250 lights before the block's own matrices and the sky light's nine coefficients — and a std140
// array is a fixed size that every fragment loops over whether or not the lights are there.
//
// A texture read with `textureLoad` has neither problem, and it is portable in a way the obvious
// alternative is not: WebGL2 has no storage buffers at all (`rhi/webgl2/capabilities.ts`), so a
// `var<storage>` light list would exist on one backend only. rgba32float is safe on both — sampling
// it with NEAREST is core WebGL2 (`EXT_color_buffer_float` is needed only to render INTO such a
// texture, `OES_texture_float_linear` only to filter one), and `textureLoad` on WebGPU needs no
// `float32-filterable` feature.
//
// It must be allocated through `device.createTexture` directly. `graphics/texture.ts` routes every
// allocation through `resolveTextureFormat`, which downgrades float formats to `rgba8unorm` on a
// device that cannot RENDER to them — correct for its callers, and silently fatal for this one.
// -----------------------------------------------------------------------------------------------

/** Texels per row. A power of two, so the shader indexes with a mask and a shift. */
export const LIGHT_DATA_WIDTH = 256;
/** log2 of {@link LIGHT_DATA_WIDTH}, uploaded so the shader shifts rather than divides. */
export const LIGHT_DATA_WIDTH_SHIFT = 8;

/** Four texels — 64 bytes — per light. See {@link packLightRecord} for the field order. */
export const LIGHT_RECORD_TEXELS = 4;

/** Four light indices ride in one rgba texel. */
export const INDICES_PER_TEXEL = 4;

/**
 * No shadow map for this light. Every value below zero means the same thing to the shader, and both
 * `spotShadow` and `pointShadow` already return "unshadowed" for one.
 */
export const NO_SHADOW_SLOT = -1;

/**
 * A point light's cone, so it can be shaded down the SPOT path.
 *
 * `spotAttenuation(cos, 0, 1)` is `saturate(cos * 0 + 1)^2`, which is exactly 1.0 for every input —
 * so `evaluateSpotLight` with these two numbers computes exactly what `evaluatePointLight` computes,
 * bit for bit, because multiplying by 1.0 is exact in IEEE. The two functions differ by that factor
 * and nothing else.
 *
 * That is what lets the cluster loop be a single call with no branch on light type, and it is why
 * the record has no `type` field at all: nothing downstream needs to know.
 */
export const POINT_CONE_SCALE = 0;
export const POINT_CONE_OFFSET = 1;

// -----------------------------------------------------------------------------------------------
// AREA LIGHTS ride in the same records, without a field any shader that predates them reads.
//
// The record shape is frozen: `cleoLight` decodes it in chunks/clusteredLights.wgsl, which is compiled
// into every custom material's prelude, so a stored custom shader breaks the moment it changes. An area
// light is therefore written as the spot or point an old path shades sensibly (render/lighting.ts) and
// says it is more in the one shadow field its kind leaves free:
//
//   one-sided  spotShadowLayer = its spot map (or -1)   pointShadowSlot = -(2 + ext)
//   two-sided  spotShadowLayer = -(2 + ext)             pointShadowSlot = its cube (or -1)
//
// where `ext` is the ABSOLUTE texel of its two-texel extension record. Every old path reads a negative
// shadow field as "no map", so it keeps the real one; chunks/areaLights.wgsl reads the marker as
// `-min(spot, point) - 2`, which is >= 0 only for an area light.
//
//   ext texel 0:  tangent.xyz (local X)   half width
//   ext texel 1:  radianceScale           half height     shape (0 rect, 1 disk)     flags (bit 0 two-sided)
//
// The LTC lookup tables (ltcTables.ts) sit at the very start of the texture, ahead of the cluster table,
// in frames that have an area light at all: 2 x 64 x 64 texels, 32 rows, uploaded once per allocation.
// -----------------------------------------------------------------------------------------------

/** Texels of an area light's extension record. */
export const AREA_EXT_TEXELS = 2;
/** Texels of the two LTC tables at the start of the texture (64 x 64 each). */
export const LTC_TEXELS = 2 * LTC_TABLE_SIZE * LTC_TABLE_SIZE;
/** Whole rows the LTC tables fill. */
export const LTC_ROWS = LTC_TEXELS / 256;
/** Shape codes the extension record carries. */
export const AREA_SHAPE_RECT = 0;
export const AREA_SHAPE_DISK = 1;
/** Extension flag bits. */
export const AREA_FLAG_TWO_SIDED = 1;

/** The shadow-field marker naming extension texel `ext`. */
export function areaMarker(extTexel: number): number { return -(2 + extTexel); }

/** The extension texel a record's two shadow fields name, or -1 when it is not an area light. */
export function areaExtensionOf(spotShadowLayer: number, pointShadowSlot: number): number {
    const ext = -Math.min(spotShadowLayer, pointShadowSlot) - 2;
    return ext >= 0 ? ext : -1;
}

/** Write an area light's extension record at `texel`. */
export function packAreaExtension(out: Float32Array, texel: number,
                                  tangent: ArrayLike<number>, halfWidth: number,
                                  radianceScale: number, halfHeight: number, shape: number, flags: number): void {
    const o = texel * 4;
    out[o] = tangent[0];
    out[o + 1] = tangent[1];
    out[o + 2] = tangent[2];
    out[o + 3] = halfWidth;
    out[o + 4] = radianceScale;
    out[o + 5] = halfHeight;
    out[o + 6] = shape;
    out[o + 7] = flags;
}

let ltcTexels: Float32Array | null = null;

/** The two LTC tables as rgba32float texels, table 1 then table 2 (decoded once). */
export function ltcTableTexels(): Float32Array {
    if (ltcTexels) return ltcTexels;
    const out = new Float32Array(LTC_TEXELS * 4);
    const half = LTC_TABLE_SIZE * LTC_TABLE_SIZE * 4;
    decodeHalfBase64(LTC_TABLE_1_HALF_BASE64, out, 0);
    decodeHalfBase64(LTC_TABLE_2_HALF_BASE64, out, half);
    ltcTexels = out;
    return out;
}

function decodeHalfBase64(b64: string, out: Float32Array, offset: number): void {
    const bin = atob(b64);   // browsers, Electron and Node 16+
    for (let i = 0; i + 1 < bin.length; i += 2) {
        const h = bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8);
        out[offset + (i >> 1)] = halfToFloat(h);
    }
}

function halfToFloat(h: number): number {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const mant = h & 0x3ff;
    if (exp === 0) return sign * mant * 2 ** -24;
    if (exp === 31) return mant ? NaN : sign * Infinity;
    return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

/**
 * Where each region starts, in texels.
 *
 * All three offsets are uniforms, so all three are free to move between frames — which is what lets
 * the regions be packed end to end with no reservation and no padding beyond a row. The alternative,
 * a fixed offset per region, would mean reserving room for the largest scene on every frame and
 * uploading it.
 */
export interface LightDataLayout {
    /** 0, or {@link LTC_TEXELS} in a frame with an area light (the LTC tables come first). */
    clusterTableTexel: number;
    lightRecordTexel: number;
    /** The area lights' extension records, {@link AREA_EXT_TEXELS} each, after the light records. */
    areaExtTexel: number;
    lightIndexTexel: number;
    /** The frame carries the LTC tables (it has an area light). */
    ltc: boolean;
    /** Total texels in use, before the round up to a whole row. */
    texelCount: number;
    /** Rows to upload. `texelCount` rounded up to {@link LIGHT_DATA_WIDTH}. */
    rows: number;
}

/** The region offsets for a frame with this many clusters, lights, index entries and area lights. */
export function lightDataLayout(clusterCount: number, lightCount: number,
                                indexCount: number, areaCount: number = 0): LightDataLayout {
    const ltc = areaCount > 0;
    const clusterTableTexel = ltc ? LTC_TEXELS : 0;
    const lightRecordTexel = clusterTableTexel + clusterCount;
    const areaExtTexel = lightRecordTexel + lightCount * LIGHT_RECORD_TEXELS;
    const lightIndexTexel = areaExtTexel + areaCount * AREA_EXT_TEXELS;
    const texelCount = lightIndexTexel + Math.ceil(indexCount / INDICES_PER_TEXEL);
    return {
        clusterTableTexel,
        lightRecordTexel,
        areaExtTexel,
        lightIndexTexel,
        ltc,
        texelCount,
        rows: Math.max(1, Math.ceil(texelCount / LIGHT_DATA_WIDTH)),
    };
}

/** Floats a staging buffer needs to hold `rows` rows. */
export function lightDataFloats(rows: number): number {
    return rows * LIGHT_DATA_WIDTH * 4;
}

/**
 * ONE record shape for point and spot lights, rather than the two arrays this replaces.
 *
 * A single record type means a single index space, which means the shader runs ONE loop over a
 * cluster instead of two over two lists — and it is what lets a light's shadow slot ride in the
 * record at all. Under the old scheme the slot was looked up BY LIGHT INDEX, through
 * `u_spotShadowLayer[i]` and `u_pointShadowSlot[i]`: two more fixed-size arrays that had to be
 * resized in lockstep with the light arrays, and two more copies of the cap.
 *
 * The fields are exactly what `PointLight` and `SpotLight` already declare in
 * `chunks/pbrLighting.wgsl`. Nothing is recomputed here and no unit is converted — the caller hands
 * over what those structs want, so the BRDF sees the same numbers it always did.
 *
 *   texel 0:  position.xyz    invRangeSquared
 *   texel 1:  color.rgb       intensity
 *   texel 2:  direction.xyz   sourceRadius
 *   texel 3:  coneScale       coneOffset      spotShadowLayer     pointShadowSlot
 *
 * THE TWO SHADOW SLOTS ARE MUTUALLY EXCLUSIVE and there is no light-type field to pick between them.
 * A light is one type or the other, so at most one slot is set and the other is
 * {@link NO_SHADOW_SLOT}; the shader takes the max of the two shadow lookups, and the one that does
 * not apply returns zero on its own guard. That is cheaper than a branch — a cluster mixes light
 * types, so a branch would diverge and cost both sides anyway — and it removes the last thing the
 * shader would have needed a `type` for.
 *
 * A point light carries {@link POINT_CONE_SCALE} / {@link POINT_CONE_OFFSET} and any unit direction.
 */
export function packLightRecord(
    out: Float32Array, texel: number,
    position: ArrayLike<number>, invRangeSquared: number,
    color: ArrayLike<number>, intensity: number,
    direction: ArrayLike<number>, sourceRadius: number,
    coneScale: number, coneOffset: number,
    spotShadowLayer: number, pointShadowSlot: number,
): void {
    const o = texel * 4;
    out[o] = position[0];
    out[o + 1] = position[1];
    out[o + 2] = position[2];
    out[o + 3] = invRangeSquared;

    out[o + 4] = color[0];
    out[o + 5] = color[1];
    out[o + 6] = color[2];
    out[o + 7] = intensity;

    out[o + 8] = direction[0];
    out[o + 9] = direction[1];
    out[o + 10] = direction[2];
    out[o + 11] = sourceRadius;

    out[o + 12] = coneScale;
    out[o + 13] = coneOffset;
    out[o + 14] = spotShadowLayer;
    out[o + 15] = pointShadowSlot;
}

/** What {@link packLightRecord} wrote. For tests and for the debug view; nothing renders through it. */
export interface LightRecord {
    position: [number, number, number];
    invRangeSquared: number;
    color: [number, number, number];
    intensity: number;
    direction: [number, number, number];
    sourceRadius: number;
    coneScale: number;
    coneOffset: number;
    spotShadowLayer: number;
    pointShadowSlot: number;
}

export function readLightRecord(data: Float32Array, texel: number): LightRecord {
    const o = texel * 4;
    return {
        position: [data[o], data[o + 1], data[o + 2]],
        invRangeSquared: data[o + 3],
        color: [data[o + 4], data[o + 5], data[o + 6]],
        intensity: data[o + 7],
        direction: [data[o + 8], data[o + 9], data[o + 10]],
        sourceRadius: data[o + 11],
        coneScale: data[o + 12],
        coneOffset: data[o + 13],
        spotShadowLayer: data[o + 14],
        pointShadowSlot: data[o + 15],
    };
}

/**
 * Copy a cluster assignment into the staging buffer at the layout's offsets.
 *
 * The table goes in as it comes out of the builder — four floats per cluster, `(offset, count, 0, 0)`
 * — because that is already one rgba texel each. The index list is a flat run of floats that lands
 * four to a texel, and the tail of the last texel is left as whatever the buffer held: no cluster's
 * count reaches into it, so nothing reads it.
 *
 * The index OFFSETS the table carries are in entries, not texels. The shader divides. Storing texel
 * offsets instead would save that divide and cost the packing a per-cluster fixup, which is the
 * wrong trade — the divide happens once per fragment and the fixup once per cluster per frame.
 */
export function packClusterBuild(out: Float32Array, layout: LightDataLayout,
                                 build: ClusterBuild, clusterCount: number): void {
    out.set(build.table.subarray(0, clusterCount * 4), layout.clusterTableTexel * 4);
    out.set(build.indices.subarray(0, build.used), layout.lightIndexTexel * 4);
}

/**
 * An area light's tangent (its width axis) in the world: the node's local X, made exactly perpendicular to
 * its emitting `normal` (local +Z, `worldForward`). `transform` is the node's world matrix, column-major.
 */
export function areaTangent(transform: ArrayLike<number>, normal: ArrayLike<number>, out: Float32Array | number[]): Float32Array | number[] {
    let x = transform[0], y = transform[1], z = transform[2];
    const d = x * normal[0] + y * normal[1] + z * normal[2];
    x -= d * normal[0]; y -= d * normal[1]; z -= d * normal[2];
    let len = Math.hypot(x, y, z);
    if (len < 1e-6) {
        // A degenerate frame (zero scale on X): any axis perpendicular to the normal.
        const a = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        x = a[1] * normal[2] - a[2] * normal[1];
        y = a[2] * normal[0] - a[0] * normal[2];
        z = a[0] * normal[1] - a[1] * normal[0];
        len = Math.hypot(x, y, z);
    }
    out[0] = x / len; out[1] = y / len; out[2] = z / len;
    return out;
}
