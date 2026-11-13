// -----------------------------------------------------------------------------------------------
// The per-object table: one rgba32float 2D texture holding, for every object a submission draws, the
// data a draw used to upload into its program's uniform block — the world matrix, the despawn
// dissolve, the camera-hole opt-in, a Basic material's UV transform, and (for skinned meshes) where its
// bone palette starts. A draw selects its record through `@builtin(instance_index)` with
// `firstInstance = record` (WebGL2: naga's `naga_vs_first_instance`, set per draw).
//
// Why a TEXTURE and not a storage buffer: WebGL2 has none, and both backends' shaders come from one
// composed WGSL source (tools/viteGlsl.mjs) — the same reasoning as lightData.ts, whose pattern this
// follows. The uniform blocks keep only what is per PASS (view, projection, light space) or per frame,
// so a sequence of draws no longer re-uploads its program's block at every draw.
//
// GL-free on purpose: the layout is tested against the WGSL constants (chunks/objectData.wgsl).
// -----------------------------------------------------------------------------------------------

/** Texels per table row. A power of two: the shader addresses with a mask and a shift. */
export const OBJECT_TABLE_WIDTH = 1024;
/** log2 of {@link OBJECT_TABLE_WIDTH}. */
export const OBJECT_TABLE_WIDTH_SHIFT = 10;

/**
 * Texels per record — a power of two, so a record never straddles a row and is addressed by a shift:
 *   t0..t3  world matrix, column by column (gl-matrix order: floats 4k..4k+3 are column k)
 *   t4      (dissolve, camera-hole opt-in 0/1, bone palette texel, reserved); a SPRITE's w is its soft fade
 *   t5      Basic UV transform (scale.x, scale.y, offset.x, offset.y); (1, 1, 0, 0) for everything else
 *   t6..t7  reserved for models; a sprite's look ({@link packSpriteRecord}):
 *           t6 (tint r, g, b as authored in sRGB, opacity), t7 (intensity, lit ambient r, g, b)
 */
export const OBJECT_RECORD_TEXELS = 8;
/** log2 of {@link OBJECT_RECORD_TEXELS}. */
export const OBJECT_RECORD_SHIFT = 3;
/** Floats per record. */
export const OBJECT_RECORD_FLOATS = OBJECT_RECORD_TEXELS * 4;

/** A bone matrix is four texels; a palette is this many bones (the skinning uniform's old array size). */
export const BONE_TEXELS = 4;
export const PALETTE_BONES = 100;
/** Records a palette occupies (it starts on a record boundary, so its matrices never straddle a row). */
export const PALETTE_RECORDS = (PALETTE_BONES * BONE_TEXELS) / OBJECT_RECORD_TEXELS;

/**
 * A node's despawn dissolve as the shader reads it: how far gone, 0 = solid. EXACTLY the expression
 * `MaterialBinder.setDissolve` writes into `u_dissolve.x`, so a record and a uniform agree to the bit.
 */
export function dissolveOf(fade: number): number {
    return fade >= 1 ? 0 : 1 - Math.max(0, fade);
}

/**
 * Write one object record into `out` at float `offset`.
 * `palette` is the texel where the object's bone palette starts, 0 for a static mesh.
 */
export function packObjectRecord(out: Float32Array, offset: number, model: ArrayLike<number>, dissolve: number,
                                 holeOptIn: boolean, palette: number,
                                 uvScaleX = 1, uvScaleY = 1, uvOffsetX = 0, uvOffsetY = 0): void {
    for (let i = 0; i < 16; i++) out[offset + i] = model[i];
    out[offset + 16] = dissolve;
    out[offset + 17] = holeOptIn ? 1 : 0;
    out[offset + 18] = palette;
    out[offset + 19] = 0;
    out[offset + 20] = uvScaleX;
    out[offset + 21] = uvScaleY;
    out[offset + 22] = uvOffsetX;
    out[offset + 23] = uvOffsetY;
    for (let i = 24; i < OBJECT_RECORD_FLOATS; i++) out[offset + i] = 0;
}

/**
 * Write one SPRITE record into `out` at float `offset`: what the batched 2D pass draws an instance from.
 * The model matrix is read from `model[modelOffset..+16]`, so a pass can keep every sprite's matrix in one
 * pooled array. `uv` is the tile's [u0, v0, u1, v1]; t5 gets it as (scale, offset) exactly as
 * {@link packObjectRecord} is handed it. Everything that differs from one sprite to the next lives here, so
 * none of it splits a batch: the shaders read t4.w / t6 / t7 where a single draw used to read uniforms.
 */
export function packSpriteRecord(out: Float32Array, offset: number, model: ArrayLike<number>, modelOffset: number,
                                 dissolve: number, uv: ArrayLike<number>, softness: number,
                                 tint: ArrayLike<number>, opacity: number, intensity: number,
                                 ambient: ArrayLike<number> | null): void {
    for (let i = 0; i < 16; i++) out[offset + i] = model[modelOffset + i];
    out[offset + 16] = dissolve;
    out[offset + 17] = 0;
    out[offset + 18] = 0;
    out[offset + 19] = softness;
    out[offset + 20] = uv[2] - uv[0];
    out[offset + 21] = uv[3] - uv[1];
    out[offset + 22] = uv[0];
    out[offset + 23] = uv[1];
    out[offset + 24] = tint[0];
    out[offset + 25] = tint[1];
    out[offset + 26] = tint[2];
    out[offset + 27] = opacity;
    out[offset + 28] = intensity;
    out[offset + 29] = ambient ? ambient[0] : 0;
    out[offset + 30] = ambient ? ambient[1] : 0;
    out[offset + 31] = ambient ? ambient[2] : 0;
}

/** Whether the records at float offsets `a` and `b` of `data` are identical. */
export function recordsEqual(data: Float32Array, a: number, b: number): boolean {
    for (let i = 0; i < OBJECT_RECORD_FLOATS; i++) if (data[a + i] !== data[b + i]) return false;
    return true;
}

/** One rectangle of an upload: `width` x `height` texels at (x, y), read from staging float `offset`. */
export interface UploadRect { x: number; y: number; width: number; height: number; offset: number }

/**
 * The texels [`first`, `end`) of a row-major table as at most three rectangles — a partial head row, whole
 * middle rows, a partial tail row — each a contiguous slice of the staging array, so an upload needs no
 * row-length state on either backend.
 */
export function uploadRects(first: number, end: number): UploadRect[] {
    const rects: UploadRect[] = [];
    if (end <= first) return rects;
    const W = OBJECT_TABLE_WIDTH;
    let t = first;
    const headRow = t >> OBJECT_TABLE_WIDTH_SHIFT, headX = t & (W - 1);
    if (headX !== 0) {
        const n = Math.min(W - headX, end - t);
        rects.push({ x: headX, y: headRow, width: n, height: 1, offset: t * 4 });
        t += n;
    }
    const fullRows = Math.floor((end - t) / W);
    if (fullRows > 0) {
        rects.push({ x: 0, y: t >> OBJECT_TABLE_WIDTH_SHIFT, width: W, height: fullRows, offset: t * 4 });
        t += fullRows * W;
    }
    if (t < end) rects.push({ x: 0, y: t >> OBJECT_TABLE_WIDTH_SHIFT, width: end - t, height: 1, offset: t * 4 });
    return rects;
}
