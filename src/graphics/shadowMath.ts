import { mat4, vec3 } from 'gl-matrix';

// Pure shadow-mapping math: functions over numbers, no renderer state and no GL calls.

/** The most cascades the shaders declare (see shaders/environment/shadows.glsl `MAX_CASCADES`). */
export const MAX_CASCADES = 4;

/**
 * Practical split scheme: a blend of the logarithmic and uniform distributions.
 * Returns the VIEW-SPACE FAR DISTANCE of each cascade, so `splits[count - 1] === far` exactly.
 *
 * `lambda` 0 = purely uniform (even world-space slabs, wastes resolution up close),
 * 1 = purely logarithmic (perceptually even, but the last cascade covers almost everything).
 */
export function computeCascadeSplits(near: number, far: number, count: number, lambda: number, out?: number[]): number[] {
    const splits = out ?? new Array<number>(count);
    splits.length = count;
    const l = Math.min(1, Math.max(0, lambda));
    // A degenerate near plane makes the logarithmic term explode (or NaN at exactly 0).
    const n = Math.max(1e-4, near);
    for (let i = 1; i <= count; i++) {
        const p = i / count;
        const logSplit = n * Math.pow(far / n, p);
        const uniformSplit = n + (far - n) * p;
        splits[i - 1] = l * logSplit + (1 - l) * uniformSplit;
    }
    // Contract: the last cascade reaches exactly `far`, whatever float error pow/lerp introduced.
    splits[count - 1] = far;
    return splits;
}

/** A bounding sphere for one camera sub-frustum, in world space. */
export interface CascadeSphere {
    center: vec3;
    radius: number;
}

/**
 * Exact bounding sphere of a perspective sub-frustum. Rotation-invariant: the radius depends only on
 * (near, far, fov, aspect), which is what lets cascades be stabilized against camera turns.
 */
export function cascadeSphereFromPerspective(
    near: number, far: number, fovYRadians: number, aspect: number,
    camPos: ArrayLike<number>, camForward: ArrayLike<number>, out?: CascadeSphere,
): CascadeSphere {
    const res = out ?? { center: vec3.create(), radius: 0 };
    const t = Math.tan(fovYRadians * 0.5);
    const k2 = t * t * (1 + aspect * aspect);

    let centerDist: number;
    let radius: number;
    if (k2 >= (far - near) / (far + near)) {
        // The slice is short and wide relative to its depth: the far cap alone bounds it.
        centerDist = far;
        radius = far * Math.sqrt(k2);
    } else {
        centerDist = 0.5 * (far + near) * (1 + k2);
        radius = 0.5 * Math.sqrt(
            (far - near) * (far - near)
            + 2 * (far * far + near * near) * k2
            + (far + near) * (far + near) * k2 * k2,
        );
    }

    res.center[0] = camPos[0] + camForward[0] * centerDist;
    res.center[1] = camPos[1] + camForward[1] * centerDist;
    res.center[2] = camPos[2] + camForward[2] * centerDist;
    res.radius = radius;
    return res;
}

/**
 * Bounding sphere of a sub-frustum given its 8 world-space corners, for orthographic cameras where
 * the centroid is the exact centre. Rotation-invariant like {@link cascadeSphereFromPerspective}.
 */
export function cascadeSphereFromCorners(corners: ArrayLike<ArrayLike<number>>, out?: CascadeSphere): CascadeSphere {
    const res = out ?? { center: vec3.create(), radius: 0 };
    let cx = 0, cy = 0, cz = 0;
    const n = corners.length;
    for (let i = 0; i < n; i++) { cx += corners[i][0]; cy += corners[i][1]; cz += corners[i][2]; }
    cx /= n; cy /= n; cz /= n;

    let r2 = 0;
    for (let i = 0; i < n; i++) {
        const dx = corners[i][0] - cx, dy = corners[i][1] - cy, dz = corners[i][2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) r2 = d2;
    }

    res.center[0] = cx; res.center[1] = cy; res.center[2] = cz;
    res.radius = Math.sqrt(r2);
    return res;
}

/**
 * Round a cascade radius up to a fixed ladder, so a viewport resize or fov change cannot drift the
 * texel grid that {@link snapToTexelGrid} quantizes against.
 */
export function quantizeRadius(radius: number, steps: number = 16): number {
    if (!(radius > 0)) return 0;
    return Math.ceil(radius * steps) / steps;
}

/** Floor `value` onto a grid of `texelSize`. Idempotent, and stable under sub-texel movement. */
export function snapToTexelGrid(value: number, texelSize: number): number {
    if (!(texelSize > 0)) return value;
    return Math.floor(value / texelSize) * texelSize;
}

/**
 * Convert a world-space depth bias into the [0,1] depth units the shadow map stores, for a cascade
 * spanning `depthRange` world units. Keeps one bias value correct across every cascade.
 */
export function cascadeDepthScale(depthRange: number): number {
    return depthRange > 1e-6 ? 1 / depthRange : 0;
}

/**
 * Build one cascade's light-space matrix: an orthographic box around `sphere` along `lightDir`, snapped to
 * the texel grid. `casterPad` pulls the near plane back. Returns the depth range for {@link cascadeDepthScale}.
 */
export function buildCascadeMatrix(
    sphere: CascadeSphere, lightDir: ArrayLike<number>, resolution: number, casterPad: number,
    out: mat4, scratch: { view: mat4; proj: mat4; up: vec3; center: vec3 }, snap: boolean = true,
): { depthRange: number; texelWorldSize: number } {
    const r = sphere.radius;
    const texelWorldSize = (2 * r) / Math.max(1, resolution);

    // A light pointing straight down or up is parallel to the default up vector, and lookAt degenerates.
    const up = Math.abs(lightDir[1]) > 0.99 ? vec3.set(scratch.up, 0, 0, 1) : vec3.set(scratch.up, 0, 1, 0);

    // Rotation only: the eye is at the world origin, so the ortho bounds below carry all translation.
    const dir = vec3.set(scratch.center, lightDir[0], lightDir[1], lightDir[2]);
    vec3.normalize(dir, dir);
    mat4.lookAt(scratch.view, [0, 0, 0], dir as vec3, up);

    const c = vec3.transformMat4(scratch.center, sphere.center as vec3, scratch.view);

    // Snap the corner, not the centre: a half-texel offset would move the samples every frame.
    const left = snap ? snapToTexelGrid(c[0] - r, texelWorldSize) : c[0] - r;
    const bottom = snap ? snapToTexelGrid(c[1] - r, texelWorldSize) : c[1] - r;

    // lookAt puts the view direction along -Z, so a point `d` units along the light has view z = -d.
    // Near/far are distances measured along -Z, hence the sign flip on c[2].
    const zNear = -c[2] - r - casterPad;
    const zFar = -c[2] + r;

    mat4.ortho(scratch.proj, left, left + 2 * r, bottom, bottom + 2 * r, zNear, zFar);
    mat4.multiply(out, scratch.proj, scratch.view);

    return { depthRange: zFar - zNear, texelWorldSize };
}

/**
 * Far plane of a spot light's shadow frustum: its own range, floored at 1 m and capped by the
 * renderer's spot-shadow distance.
 *
 * This used to solve `1 / (c + l*d + q*d^2) = 1/256` for d, because a legacy light had no range and
 * one had to be inferred. Lights carry a real range now, and that solve moved to
 * `graphics/lighting.ts` as `legacyRange`, where the migration uses it — the two must agree or a
 * migrated light's shadow frustum ends somewhere other than its light, and a shadow clipped partway
 * down a cone does not look like a units bug.
 */
export function spotShadowFar(range: number, maxFar: number): number {
    if (!(range > 0) || !isFinite(range)) return maxFar;
    return Math.min(maxFar, Math.max(1, range));
}

/**
 * Stable slot assignment for punctual shadow maps, keyed by node id. Must not key on
 * `LightNode.index` — Scene recomputes it from traversal order whenever any node is added or moved.
 *
 * Used by BOTH the spot atlas (one layer per slot) and the point-light cube atlas (six consecutive
 * layers per slot, `slot * 6 + face`). The policy that matters to both: a caster that already holds
 * a slot keeps it, so a light drifting across the capacity boundary goes dark once rather than
 * strobing as the assignment reshuffles around it.
 */
export class SpotShadowSlots {
    private _capacity: number;
    private readonly _byId: Map<string, number> = new Map();

    constructor(capacity: number) {
        this._capacity = Math.max(0, capacity);
    }

    public get capacity(): number { return this._capacity; }
    public set capacity(n: number) {
        this._capacity = Math.max(0, n);
        for (const [id, layer] of this._byId)
            if (layer >= this._capacity) this._byId.delete(id);
    }

    /** Layer assigned to `id`, or -1 if it has none. */
    public layerOf(id: string): number {
        const layer = this._byId.get(id);
        return layer === undefined ? -1 : layer;
    }

    /**
     * Reconcile the assignment with this frame's caster list: existing ids keep their layer, departed
     * ids release theirs, new ids take the lowest free one. Casters past capacity go unshadowed.
     */
    public update(ids: readonly string[]): Map<string, number> {
        const wanted = new Set(ids);
        const free: boolean[] = new Array(this._capacity).fill(true);

        for (const [id, layer] of [...this._byId]) {
            if (!wanted.has(id)) { this._byId.delete(id); continue; }
            free[layer] = false;
        }
        for (const id of ids) {
            if (this._byId.has(id)) continue;
            const layer = free.indexOf(true);
            if (layer < 0) continue; // out of layers — this caster goes unshadowed
            free[layer] = false;
            this._byId.set(id, layer);
        }
        return this._byId;
    }

    public clear(): void { this._byId.clear(); }
}

// ---------------------------------------------------------------------------------------------
// Point-light (cube) shadow maps.
//
// The cube is UNWRAPPED into six consecutive layers of a depth texture array rather than stored as
// a hardware cubemap, and that is forced rather than chosen: WebGL2 has no cubemap arrays (GLSL ES
// 3.00 has `samplerCubeShadow` but no `samplerCubeArrayShadow`), so a real depth cube would serve
// exactly one light and cost its own sampler unit — and the deferred pass already binds 13 of a hard
// 16. The RHI cannot render depth into a cube face either; `WebGL2Framebuffer.attachDepth` throws.
//
// Unwrapped, the whole feature reuses LayeredDepthFramebuffer, `_beginDepthPass` and
// `_renderShadowCasters` exactly as the spot atlas does, for one sampler and no backend divergence.
// ---------------------------------------------------------------------------------------------

/** The most shadow-casting point lights the shaders declare (see chunks/shadows.wgsl). */
export const MAX_POINT_SHADOWS = 4;

/**
 * The six cube-face frames, in the `+X -X +Y -Y +Z -Z` order the shader's major-axis selector
 * assumes. `dir` is the view direction from the light; `up` completes an ordinary right-handed
 * camera.
 *
 * DELIBERATELY NOT `Renderer._CUBE_FACES`. That table is the OpenGL cubemap convention, whose
 * left-handed face basis is exactly why probe capture has to reverse winding (`_cubeFaceCapture`).
 * A mirrored view matrix swaps which triangles count as front-facing, and the shadow pass rasterizes
 * with FRONT-face culling to push acne onto surfaces the camera cannot see — so a mirrored frame
 * would silently cull the wrong half of every caster. Nothing samples this atlas AS a cubemap, so
 * the frames only have to be self-consistent with {@link cubeFaceIndex}, and proper rotations are
 * the ones that keep the rest of the shadow path unchanged.
 */
export const POINT_SHADOW_FACES: readonly { dir: vec3; up: vec3 }[] = [
    { dir: vec3.fromValues( 1,  0,  0), up: vec3.fromValues(0, 1, 0) }, // +X
    { dir: vec3.fromValues(-1,  0,  0), up: vec3.fromValues(0, 1, 0) }, // -X
    { dir: vec3.fromValues( 0,  1,  0), up: vec3.fromValues(0, 0, 1) }, // +Y
    { dir: vec3.fromValues( 0, -1,  0), up: vec3.fromValues(0, 0, 1) }, // -Y
    { dir: vec3.fromValues( 0,  0,  1), up: vec3.fromValues(0, 1, 0) }, // +Z
    { dir: vec3.fromValues( 0,  0, -1), up: vec3.fromValues(0, 1, 0) }, // -Z
];

/**
 * Which cube face the direction `(x, y, z)` falls in, by major axis.
 *
 * The JS twin of `cleoCubeFace` in chunks/shadows.wgsl — including the tie-breaks, which is the
 * whole point of having it here. The two must agree exactly or a fragment samples the face next to
 * the one it was rasterized into, which reads as a shadow torn along a 45-degree line rather than as
 * an indexing bug. Kept honest by tests/shadowMath.test.ts.
 */
export function cubeFaceIndex(x: number, y: number, z: number): number {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    if (ax >= ay && ax >= az) return x > 0 ? 0 : 1;
    if (ay >= az) return y > 0 ? 2 : 3;
    return z > 0 ? 4 : 5;
}

/**
 * Full field of view, in radians, to rasterize one cube face with.
 *
 * Six faces at exactly 90 degrees tile the cube with no overlap, so a PCF tap near a face edge lands
 * outside [0,1] and clamp-to-edge answers with a border texel that describes somewhere else — a
 * bright or dark cross along all twelve cube edges. Widening each face by `borderTexels` gives the
 * kernel real depth to land on:
 *
 *     tan(halfFov) = 1 / (1 - 2 * borderTexels / resolution)
 *
 * (tan(45 degrees) = 1 is the un-widened face.) Read it as: put the un-widened face's edge exactly
 * `borderTexels` inside the widened map. The reciprocal form and not the obvious
 * `1 + 2 * border / res` because the border is measured in the WIDENED map's texels — that
 * off-by-a-factor leaves the outermost tap a fraction of a texel short, which is precisely the case
 * the seam shows up in. The overlap is tiny either way: a 3x3 kernel at 512 costs about half a
 * degree. Face SELECTION still uses the un-widened major axis, so every direction lands inside its
 * face with margin to spare. Returns exactly PI/2 when `borderTexels` is 0.
 */
export function pointShadowFov(resolution: number, borderTexels: number): number {
    const res = Math.max(1, resolution);
    const border = Math.max(0, borderTexels);
    // Floored for the degenerate case (a tiny map with a huge filter radius), where the solve runs
    // to a zero or negative denominator. A face past this covers so much of the cube that the
    // overlap costs more resolution than the seam ever did.
    const tan = 1 / Math.max(0.25, 1 - (2 * border) / res);
    return 2 * Math.atan(tan);
}

// FNV-1a over the BIT PATTERN of an f32, not over the value. Two light positions can differ by less
// than any epsilon worth picking and still be a different pixel at a 512-texel face, and truncating
// to f32 first is not a loss — it is the precision the GPU will see anyway.
const _hashF32 = new Float32Array(1);
const _hashU32 = new Uint32Array(_hashF32.buffer);

/** FNV-1a offset basis. */
export const HASH_SEED = 0x811c9dc5;

/** Mix one number into a running FNV-1a hash. */
export function mixNumber(h: number, v: number): number {
    _hashF32[0] = v;
    return Math.imul(h ^ _hashU32[0], 0x01000193) >>> 0;
}

/** Mix a string (a node id) into a running FNV-1a hash. */
export function mixString(h: number, s: string): number {
    let out = h;
    for (let i = 0; i < s.length; i++) out = Math.imul(out ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return out >>> 0;
}

/** Mix a 16-element matrix into a running FNV-1a hash. */
export function mixTransform(h: number, m: ArrayLike<number>): number {
    let out = h;
    for (let i = 0; i < 16; i++) out = mixNumber(out, m[i]);
    return out >>> 0;
}

/**
 * Remembers what each point-shadow slot was last rasterized for, so a light only re-renders its six
 * faces when something that would change them moved.
 *
 * Six depth passes per light is the whole cost of this feature, and a lamp bolted to a ceiling over
 * static geometry is the common case — that case should cost nothing after the first frame. The key
 * is the light's position, its far plane, and a hash of the casters standing inside its range. The
 * PROJECTION is deliberately not in it: everything that changes the projection (resolution, filter
 * radius) invalidates every slot outright through {@link invalidateAll}, which is both cheaper and
 * harder to get subtly wrong than threading another float through the key.
 */
export class PointShadowCache {
    private readonly _x: Float64Array;
    private readonly _y: Float64Array;
    private readonly _z: Float64Array;
    private readonly _far: Float64Array;
    private readonly _hash: Int32Array;
    private readonly _valid: boolean[];

    constructor(capacity: number) {
        const n = Math.max(0, capacity);
        this._x = new Float64Array(n);
        this._y = new Float64Array(n);
        this._z = new Float64Array(n);
        this._far = new Float64Array(n);
        this._hash = new Int32Array(n);
        this._valid = new Array<boolean>(n).fill(false);
    }

    public get capacity(): number { return this._valid.length; }

    /**
     * Does slot `slot` need re-rasterizing for this light? RECORDS the new key either way, so two
     * calls in one frame answer differently — call it once per slot per frame.
     */
    public needsUpdate(slot: number, pos: ArrayLike<number>, far: number, casterHash: number): boolean {
        // A slot outside the cache has nothing remembered about it, so the only safe answer is yes.
        if (slot < 0 || slot >= this._valid.length) return true;
        const stale = !this._valid[slot]
            || this._x[slot] !== pos[0] || this._y[slot] !== pos[1] || this._z[slot] !== pos[2]
            || this._far[slot] !== far || this._hash[slot] !== (casterHash | 0);
        this._valid[slot] = true;
        this._x[slot] = pos[0]; this._y[slot] = pos[1]; this._z[slot] = pos[2];
        this._far[slot] = far; this._hash[slot] = casterHash | 0;
        return stale;
    }

    /** Drop one slot's memory — its light stopped casting, or handed the slot to another. */
    public release(slot: number): void {
        if (slot >= 0 && slot < this._valid.length) this._valid[slot] = false;
    }

    /** Force every slot to re-rasterize. Required after a reallocation: fresh depth storage is undefined. */
    public invalidateAll(): void { this._valid.fill(false); }
}
