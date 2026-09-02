import type { ClusterBuild } from './clusters';

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

/**
 * Where each region starts, in texels.
 *
 * All three offsets are uniforms, so all three are free to move between frames — which is what lets
 * the regions be packed end to end with no reservation and no padding beyond a row. The alternative,
 * a fixed offset per region, would mean reserving room for the largest scene on every frame and
 * uploading it.
 */
export interface LightDataLayout {
    /** Always 0. Named anyway, because the shader reads it as a uniform like the other two. */
    clusterTableTexel: number;
    lightRecordTexel: number;
    lightIndexTexel: number;
    /** Total texels in use, before the round up to a whole row. */
    texelCount: number;
    /** Rows to upload. `texelCount` rounded up to {@link LIGHT_DATA_WIDTH}. */
    rows: number;
}

/** The region offsets for a frame with this many clusters, lights and index entries. */
export function lightDataLayout(clusterCount: number, lightCount: number,
                                indexCount: number): LightDataLayout {
    const lightRecordTexel = clusterCount;
    const lightIndexTexel = lightRecordTexel + lightCount * LIGHT_RECORD_TEXELS;
    const texelCount = lightIndexTexel + Math.ceil(indexCount / INDICES_PER_TEXEL);
    return {
        clusterTableTexel: 0,
        lightRecordTexel,
        lightIndexTexel,
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
