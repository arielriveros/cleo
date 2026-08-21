import { mat4, vec3 } from 'gl-matrix';

/**
 * Pure shadow-mapping math, deliberately free of any GL call.
 *
 * The cascade fit is the part of shadow mapping that silently produces "everything is black" or
 * "the shadows swim when I turn the camera", and neither failure is visible in a screenshot review.
 * Keeping it here — as functions over numbers, with no renderer state and no GL context — is what
 * makes it unit-testable (see tests/shadowMath.test.ts); the renderer holds the buffers and calls in.
 */

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
    // Float error in pow/lerp can leave the last split a hair short of `far`, which would drop a thin
    // shell of the world out of every cascade. The contract is that the last cascade reaches exactly far.
    splits[count - 1] = far;
    return splits;
}

/** A bounding sphere for one camera sub-frustum, in world space. */
export interface CascadeSphere {
    center: vec3;
    radius: number;
}

/**
 * Exact bounding sphere of a PERSPECTIVE sub-frustum, computed from the camera's parameters rather
 * than its orientation.
 *
 * This is the whole reason cascades can be stabilized: the radius depends only on (near, far, fov,
 * aspect) and the centre only on (camera position, camera forward), so rotating the camera moves the
 * sphere rigidly and never changes its size. The old 8-corner min/max fit was taken in LIGHT space,
 * whose axes do not rotate with the camera — so the box grew and shrank as the camera turned, and the
 * shadow texels crawled across the world with it.
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
 * Bounding sphere of an arbitrary sub-frustum given its 8 world-space corners. Used for orthographic
 * cameras, where the slice is a box and the centroid IS the exact centre. Also rotation-invariant:
 * turning the camera transforms every corner rigidly, so the centroid and every corner distance move
 * with it unchanged.
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
 * Round a cascade radius up to a fixed ladder of values.
 *
 * The radius is invariant under camera rotation but not under a viewport resize or an fov change,
 * both of which shift it by a hair every frame while the user drags a panel divider. Since the texel
 * grid the snap quantizes to is derived from the radius, a continuously-changing radius means a
 * continuously-changing grid — which is exactly the shimmer the snap exists to remove.
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
 * whose orthographic depth range is `depthRange` world units.
 *
 * Without this, one bias slider is correct for exactly one cascade at one shadow distance: cascade 0
 * might span 30 world units of depth and cascade 3 six hundred, so the same raw depth constant is
 * 20x more (or less) aggressive depending on which cascade a pixel lands in.
 */
export function cascadeDepthScale(depthRange: number): number {
    return depthRange > 1e-6 ? 1 / depthRange : 0;
}

/**
 * Build one cascade's light-space matrix: an orthographic box around `sphere`, oriented along
 * `lightDir`, with its footprint snapped to the shadow map's texel grid.
 *
 * `casterPad` pulls the near plane back toward the light so occluders BETWEEN the light and the
 * slice still rasterize into the map — without it, a wall just outside the slice casts nothing.
 *
 * Returns the cascade's world-space depth range, which the caller needs for `cascadeDepthScale`.
 */
export function buildCascadeMatrix(
    sphere: CascadeSphere, lightDir: ArrayLike<number>, resolution: number, casterPad: number,
    out: mat4, scratch: { view: mat4; proj: mat4; up: vec3; center: vec3 }, snap: boolean = true,
): { depthRange: number; texelWorldSize: number } {
    const r = sphere.radius;
    const texelWorldSize = (2 * r) / Math.max(1, resolution);

    // A light pointing straight down (or up) is parallel to the default up vector, which makes
    // lookAt degenerate (a zero-length cross product -> NaN through the whole matrix).
    const up = Math.abs(lightDir[1]) > 0.99 ? vec3.set(scratch.up, 0, 0, 1) : vec3.set(scratch.up, 0, 1, 0);

    // Rotation only: the eye sits at the world origin, so the matrix is a pure change of basis and
    // the ortho bounds below carry ALL of the translation. That is what makes snapping possible —
    // there is exactly one place the footprint's position is expressed, and it is a pair of scalars.
    const dir = vec3.set(scratch.center, lightDir[0], lightDir[1], lightDir[2]);
    vec3.normalize(dir, dir);
    mat4.lookAt(scratch.view, [0, 0, 0], dir as vec3, up);

    const c = vec3.transformMat4(scratch.center, sphere.center as vec3, scratch.view);

    // Snap the footprint's corner (not its centre) to the texel grid: a half-texel offset in the
    // projection is what makes the depth samples land on the same world positions frame to frame.
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
 * Distance at which a spot light's attenuation has fallen to `cutoffRatio` of its peak, used as the
 * far plane of its shadow frustum. Solves `1 / (c + l*d + q*d^2) = cutoffRatio` for d.
 *
 * A spot light has no authored range in this engine — only the three attenuation coefficients — so
 * the frustum has to be derived from them or every spot would need a hand-tuned far plane.
 */
export function spotShadowFar(
    constant: number, linear: number, quadratic: number, maxFar: number, cutoffRatio: number = 1 / 256,
): number {
    const target = 1 / Math.max(1e-6, cutoffRatio); // c + l*d + q*d^2 == target
    const b = target - constant;
    let d: number;
    if (quadratic > 1e-9) {
        const disc = linear * linear + 4 * quadratic * b;
        d = disc > 0 ? (-linear + Math.sqrt(disc)) / (2 * quadratic) : 0;
    } else if (linear > 1e-9) {
        d = b / linear;
    } else {
        // No falloff at all: the light reaches forever, so only the global cap bounds it.
        d = maxFar;
    }
    if (!(d > 0) || !isFinite(d)) d = maxFar;
    return Math.min(maxFar, Math.max(1, d));
}

/**
 * Stable layer assignment for spot-light shadow maps, keyed by node id.
 *
 * `LightNode.index` looks like the obvious key and is a trap: Scene assigns it as a dense compaction
 * over traversal order, so adding, removing or reparenting ANY node renumbers every spotlight after
 * it. Keying the atlas by index would silently hand light B the depth map that was rendered for
 * light A, one frame after an unrelated node was spawned.
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
     * Reconcile the assignment with this frame's caster list. Ids that already hold a layer keep it
     * (that is the point); ids that dropped out release theirs; new ids take the lowest free layer,
     * in the order given. Casters past capacity get -1 and simply go unshadowed.
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
