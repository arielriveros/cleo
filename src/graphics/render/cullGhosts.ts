/**
 * The split viewport's culling view, its GL-free half: what a verdict means, how the ghosts are tinted,
 * and the line geometry they are drawn with. A preview pane that shows the EDITING view's culling
 * (render/viewLayout.ts `PaneCulling`) leaves out what that view culled and draws each culled thing as a
 * tinted line ghost instead (EditorOverlays `_drawCullGhosts`). A leaf: gl-matrix only, so it is testable
 * on its own and importable from visibility, foliage and lighting alike.
 */

/** Why the editing view culled something: outside its frustum (or its light grid's depth range). */
export const CULL_OUTSIDE = 1;
/** Why the editing view culled something: an occluder, an occlusion query or an occlusion volume hid it. */
export const CULL_OCCLUDED = 2;
/** 0: drawn; otherwise why the editing view culled it. */
export type CullVerdict = 0 | typeof CULL_OUTSIDE | typeof CULL_OCCLUDED;

/** Ghost tints, linear RGB: outside the view amber, occluded violet. */
export const GHOST_OUTSIDE_COLOR: [number, number, number] = [1.0, 0.62, 0.15];
export const GHOST_OCCLUDED_COLOR: [number, number, number] = [0.72, 0.45, 1.0];
/** How opaque the ghost lines are over the preview image. */
export const GHOST_OPACITY = 0.85;
/** A mesh with more triangles than this is ghosted as its box: its full wireframe would bury the view. */
export const GHOST_MESH_TRIANGLE_LIMIT = 50000;
/** How far out the editing camera's frustum is drawn, metres: an editor camera's far plane is 10 km. */
export const GHOST_FRUSTUM_REACH = 1000;

/** Line-list geometry: positions (xyz per vertex) and index pairs. */
export interface LineGeometry {
    positions: [number, number, number][];
    indices: number[];
}

/**
 * The edges of a triangle list as a line list, each shared edge once. `indices` are triangle corners in
 * threes; an index buffer that is not a whole number of triangles has its tail ignored.
 */
export function edgeIndices(indices: ArrayLike<number>): Uint32Array {
    const out: number[] = [];
    const seen = new Set<number>();
    const tris = Math.floor(indices.length / 3);
    // Keyed by the smaller index times a stride past the largest, so any vertex count fits a double exactly.
    let max = 0;
    for (let i = 0; i < tris * 3; i++) if (indices[i] > max) max = indices[i];
    const stride = max + 1;
    const add = (a: number, b: number) => {
        if (a === b) return;
        const lo = a < b ? a : b, hi = a < b ? b : a;
        const key = lo * stride + hi;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(lo, hi);
    };
    for (let t = 0; t < tris; t++) {
        const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
        add(a, b); add(b, c); add(c, a);
    }
    return Uint32Array.from(out);
}

/** A unit box outline, -0.5..0.5 on each axis: scaled and moved onto any box by its instance matrix. */
export function unitBoxLines(): LineGeometry {
    const positions: [number, number, number][] = [];
    for (let i = 0; i < 8; i++) positions.push([(i & 1) ? 0.5 : -0.5, (i & 2) ? 0.5 : -0.5, (i & 4) ? 0.5 : -0.5]);
    const indices = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];
    return { positions, indices };
}

/**
 * A unit segment from the origin to (0, 0, 1). An instance matrix whose third column is B - A and whose
 * fourth is A draws it from A to B: the line's points are only ever z multiples, so the first two columns
 * never matter (see `segmentMatrix`).
 */
export function unitSegmentLines(): LineGeometry {
    return { positions: [[0, 0, 0], [0, 0, 1]], indices: [0, 1] };
}

/** The instance matrix that lays `unitSegmentLines` from `a` to `b` (column-major, into `out` at `offset`). */
export function segmentMatrix(out: Float32Array, offset: number, a: ArrayLike<number>, b: ArrayLike<number>): void {
    out.fill(0, offset, offset + 16);
    out[offset] = 1;
    out[offset + 5] = 1;
    out[offset + 8] = b[0] - a[0]; out[offset + 9] = b[1] - a[1]; out[offset + 10] = b[2] - a[2];
    out[offset + 12] = a[0]; out[offset + 13] = a[1]; out[offset + 14] = a[2]; out[offset + 15] = 1;
}

/** A unit sphere as three great circles, `segments` lines each: a light's reach. */
export function unitSphereLines(segments = 32): LineGeometry {
    const positions: [number, number, number][] = [];
    const indices: number[] = [];
    for (let axis = 0; axis < 3; axis++) {
        const base = positions.length;
        for (let i = 0; i < segments; i++) {
            const a = (i / segments) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
            positions.push(axis === 0 ? [0, c, s] : axis === 1 ? [c, 0, s] : [c, s, 0]);
            indices.push(base + i, base + (i + 1) % segments);
        }
    }
    return { positions, indices };
}

/**
 * A unit cone opening along +Z: apex at the origin, its base a circle of radius 1 at z = 1, with four
 * lines from the apex to it. `coneMatrix` lays it along a spotlight's reach.
 */
export function unitConeLines(segments = 32): LineGeometry {
    const positions: [number, number, number][] = [[0, 0, 0]];
    const indices: number[] = [];
    for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        positions.push([Math.cos(a), Math.sin(a), 1]);
        indices.push(1 + i, 1 + (i + 1) % segments);
    }
    for (let k = 0; k < 4; k++) indices.push(0, 1 + (k * segments) / 4);
    return { positions, indices };
}

/**
 * The instance matrix that lays `unitConeLines` from `apex` along the unit `dir`, `length` long and
 * `radius` wide at its end (column-major, into `out` at `offset`). The circle's roll about the axis is
 * arbitrary: a cone looks the same at any.
 */
export function coneMatrix(out: Float32Array, offset: number, apex: ArrayLike<number>, dir: ArrayLike<number>,
                           length: number, radius: number): void {
    // Any axis across `dir`: the world axis least along it, crossed with it.
    const ax = Math.abs(dir[0]), ay = Math.abs(dir[1]), az = Math.abs(dir[2]);
    const helper = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
    let ux = dir[1] * helper[2] - dir[2] * helper[1];
    let uy = dir[2] * helper[0] - dir[0] * helper[2];
    let uz = dir[0] * helper[1] - dir[1] * helper[0];
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = dir[1] * uz - dir[2] * uy, vy = dir[2] * ux - dir[0] * uz, vz = dir[0] * uy - dir[1] * ux;
    out[offset] = ux * radius; out[offset + 1] = uy * radius; out[offset + 2] = uz * radius; out[offset + 3] = 0;
    out[offset + 4] = vx * radius; out[offset + 5] = vy * radius; out[offset + 6] = vz * radius; out[offset + 7] = 0;
    out[offset + 8] = dir[0] * length; out[offset + 9] = dir[1] * length; out[offset + 10] = dir[2] * length; out[offset + 11] = 0;
    out[offset + 12] = apex[0]; out[offset + 13] = apex[1]; out[offset + 14] = apex[2]; out[offset + 15] = 1;
}

/** The instance matrix that lays a unit (-0.5..0.5) box onto `min`..`max` (column-major, at `offset`). */
export function boxMatrix(out: Float32Array, offset: number, min: ArrayLike<number>, max: ArrayLike<number>): void {
    out.fill(0, offset, offset + 16);
    out[offset] = Math.max(1e-4, max[0] - min[0]);
    out[offset + 5] = Math.max(1e-4, max[1] - min[1]);
    out[offset + 10] = Math.max(1e-4, max[2] - min[2]);
    out[offset + 12] = (min[0] + max[0]) / 2;
    out[offset + 13] = (min[1] + max[1]) / 2;
    out[offset + 14] = (min[2] + max[2]) / 2;
    out[offset + 15] = 1;
}

/** The instance matrix that lays a unit sphere at `center`, `radius` across (column-major, at `offset`). */
export function sphereMatrix(out: Float32Array, offset: number, center: ArrayLike<number>, radius: number): void {
    out.fill(0, offset, offset + 16);
    out[offset] = radius; out[offset + 5] = radius; out[offset + 10] = radius;
    out[offset + 12] = center[0]; out[offset + 13] = center[1]; out[offset + 14] = center[2]; out[offset + 15] = 1;
}

/** What `frustumCorners` reads of a camera (core/camera.ts `Camera` has all of it). */
export interface FrustumCamera {
    readonly type: 'perspective' | 'orthographic';
    readonly position: ArrayLike<number>;
    readonly viewMatrix: ArrayLike<number>;
    /** Vertical field of view, degrees. */
    readonly fov: number;
    /** Width over height. */
    readonly ratio: number;
    readonly near: number;
    readonly far: number;
    readonly left: number;
    readonly right: number;
    readonly bottom: number;
    readonly top: number;
}

/**
 * The 8 corners of `camera`'s view volume, world space, as 24 floats: the near rectangle (bottom-left,
 * bottom-right, top-right, top-left), then the far one in the same order. The far plane is pulled in to
 * `maxFar`. Worked out from the camera itself rather than by unprojecting NDC, so it never depends on a
 * backend's clip depth range. An orthographic camera's left and right are scaled by its ratio, as its
 * projection is (core/camera.ts).
 */
export function frustumCorners(camera: FrustumCamera, maxFar = GHOST_FRUSTUM_REACH): Float32Array {
    const v = camera.viewMatrix, p = camera.position;
    // The view matrix's rows are the camera's right, up and back axes.
    const right = [v[0], v[4], v[8]], up = [v[1], v[5], v[9]], fwd = [-v[2], -v[6], -v[10]];
    const near = camera.near, far = Math.max(near, Math.min(camera.far, maxFar));
    const out = new Float32Array(24);
    const put = (corner: number, depth: number, x: number, y: number) => {
        for (let i = 0; i < 3; i++) out[corner * 3 + i] = p[i] + fwd[i] * depth + right[i] * x + up[i] * y;
    };
    const ratio = camera.ratio > 0 ? camera.ratio : 1;
    [near, far].forEach((depth, plane) => {
        let l: number, r: number, b: number, t: number;
        if (camera.type === 'orthographic') {
            l = camera.left * ratio; r = camera.right * ratio; b = camera.bottom; t = camera.top;
        } else {
            const h = depth * Math.tan((camera.fov * Math.PI / 180) / 2), w = h * ratio;
            l = -w; r = w; b = -h; t = h;
        }
        const o = plane * 4;
        put(o, depth, l, b); put(o + 1, depth, r, b); put(o + 2, depth, r, t); put(o + 3, depth, l, t);
    });
    return out;
}

/** The 12 edges of `frustumCorners`' box, as corner index pairs. */
export const FRUSTUM_EDGES: readonly number[] = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
