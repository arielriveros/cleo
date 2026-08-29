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
 * Stable layer assignment for spot-light shadow maps, keyed by node id. Must not key on
 * `LightNode.index` — Scene recomputes it from traversal order whenever any node is added or moved.
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
