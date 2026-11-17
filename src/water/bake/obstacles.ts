import { mat4, quat, vec3 } from 'gl-matrix';

// What stands in the water when it is baked: every STATIC collider (a Collider with no mass, solid to the
// solver) as authored — a rock, a pier, a weir, a wall. Read from the authored shapes, because the editor's
// scene has no physics bodies (a Collider builds its body only in a running scene), and the same rule the GI
// bake uses (render/gi/giMotion.ts): what is authored to move is not an obstacle, so a bake made in Edit
// matches the scene in Play.
//
// Pure apart from the scene it walks; `obstacleSpan` is what the bake rasterises with: where a vertical
// line through (x, z) is inside the obstacle.

export type WaterObstacleKind = 'box' | 'sphere' | 'capsule' | 'cylinder' | 'convex';

export interface WaterObstacle {
    kind: WaterObstacleKind;
    /** World -> the shape's own space (its node's placement and the shape's offset and rotation). */
    inverse: mat4;
    /** box: half extents; sphere: radius; capsule: radius, half the straight part; cylinder: radius, half height. */
    dims: number[];
    /** convex: its faces as planes in the shape's space, [nx, ny, nz, d] each (inside: n·p <= d). */
    planes: number[];
    /** World-space bounds. */
    min: [number, number, number];
    max: [number, number, number];
    /** What it was built from, for the bake's signature. */
    key: string;
    /** The collider it is a shape of (its node's id). */
    node: string;
}

/** The authored-collider fields read here (core/scene/nodes/colliderNode.ts), duck-typed. */
interface ColliderLike {
    nodeType: string; id: string; mass: number; simulatePhysics?: boolean; enabled?: boolean;
    shapes: { type: string; offset?: number[]; rotation?: number[]; width?: number; height?: number; depth?: number; radius?: number; vertices?: number[][]; faces?: number[][] }[];
    worldTransform: mat4; worldScale: ArrayLike<number>;
}

/**
 * The drag coefficient of what stands in the water and is narrower than a simulation's cell: a round pier's or
 * a post's in a current (1 to 1.2; a square one's is nearer 2). The flow bake and the local flow both use it.
 */
export const OBSTACLE_DRAG = 1.2;

/** Centimetres: what an obstacle's key is rounded to (a tool composing the same transform agrees with the editor). */
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Inside the shape, in its own space. */
function inside(o: WaterObstacle, p: ArrayLike<number>): boolean {
    const d = o.dims;
    switch (o.kind) {
        case 'box': return Math.abs(p[0]) <= d[0] && Math.abs(p[1]) <= d[1] && Math.abs(p[2]) <= d[2];
        case 'sphere': return p[0] * p[0] + p[1] * p[1] + p[2] * p[2] <= d[0] * d[0];
        case 'capsule': {
            const y = Math.max(-d[1], Math.min(d[1], p[1]));
            return p[0] * p[0] + (p[1] - y) * (p[1] - y) + p[2] * p[2] <= d[0] * d[0];
        }
        case 'cylinder': return Math.abs(p[1]) <= d[1] && p[0] * p[0] + p[2] * p[2] <= d[0] * d[0];
        case 'convex': {
            const pl = o.planes;
            for (let i = 0; i < pl.length; i += 4) if (pl[i] * p[0] + pl[i + 1] * p[1] + pl[i + 2] * p[2] > pl[i + 3] + 1e-6) return false;
            return pl.length > 0;
        }
    }
}

/** A shape's bounding box in its own space. */
function localBounds(kind: WaterObstacleKind, dims: number[], verts: number[][]): [number[], number[]] {
    if (kind === 'convex') {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const v of verts) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], v[a]); max[a] = Math.max(max[a], v[a]); }
        return [min, max];
    }
    const e = kind === 'box' ? dims : kind === 'sphere' ? [dims[0], dims[0], dims[0]]
        : kind === 'capsule' ? [dims[0], dims[1] + dims[0], dims[0]] : [dims[0], dims[1], dims[0]];
    return [[-e[0], -e[1], -e[2]], [e[0], e[1], e[2]]];
}

/** The static obstacles among `nodes` (a scene's), within the world rectangle `area` ([x0, z0, x1, z1]) if given. */
export function sceneObstacles(nodes: Iterable<unknown>, area?: readonly number[]): WaterObstacle[] {
    const out: WaterObstacle[] = [];
    const q = quat.create(), sq = quat.create(), t = vec3.create(), m = mat4.create(), local = mat4.create();
    for (const raw of nodes) {
        const n = raw as ColliderLike;
        if (!n || n.nodeType !== 'collider' || n.mass > 0 || n.simulatePhysics === false || n.enabled === false) continue;
        if (!Array.isArray(n.shapes) || !n.shapes.length) continue;
        const scale = n.worldScale;
        const sx = Math.abs(scale[0]) || 1, sy = Math.abs(scale[1]) || 1, sz = Math.abs(scale[2]) || 1;
        mat4.getRotation(q, n.worldTransform);
        mat4.getTranslation(t, n.worldTransform);
        n.shapes.forEach((shape, si) => {
            let kind: WaterObstacleKind, dims: number[] = [], planes: number[] = [], verts: number[][] = [];
            if (shape.type === 'box') { kind = 'box'; dims = [(shape.width ?? 1) * sx / 2, (shape.height ?? 1) * sy / 2, (shape.depth ?? 1) * sz / 2]; }
            else if (shape.type === 'sphere') { kind = 'sphere'; dims = [(shape.radius ?? 0.5) * Math.max(sx, sy, sz)]; }
            else if (shape.type === 'capsule') {
                const r = (shape.radius ?? 0.5) * Math.max(sx, sz);
                kind = 'capsule'; dims = [r, Math.max(0, (shape.height ?? 2) * sy - 2 * r) / 2];
            } else if (shape.type === 'cylinder') { kind = 'cylinder'; dims = [(shape.radius ?? 0.5) * Math.max(sx, sz), (shape.height ?? 1) * sy / 2]; }
            else if (shape.type === 'convex' && Array.isArray(shape.vertices) && Array.isArray(shape.faces)) {
                kind = 'convex';
                verts = shape.vertices.map(v => [v[0] * sx, v[1] * sy, v[2] * sz]);
                const c = [0, 0, 0];
                for (const v of verts) { c[0] += v[0] / verts.length; c[1] += v[1] / verts.length; c[2] += v[2] / verts.length; }
                for (const f of shape.faces) {
                    if (f.length < 3) continue;
                    const a = verts[f[0]], b = verts[f[1]], d = verts[f[2]];
                    if (!a || !b || !d) continue;
                    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
                    let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
                    const l = Math.hypot(nx, ny, nz);
                    if (l < 1e-9) continue;
                    nx /= l; ny /= l; nz /= l;
                    let dd = nx * a[0] + ny * a[1] + nz * a[2];
                    // Outward: away from the centre.
                    if (nx * c[0] + ny * c[1] + nz * c[2] > dd) { nx = -nx; ny = -ny; nz = -nz; dd = -dd; }
                    planes.push(nx, ny, nz, dd);
                }
            } else return;
            // World = node translation * node rotation * (scaled offset) * shape rotation.
            const off = shape.offset ?? [0, 0, 0], rot = shape.rotation ?? [0, 0, 0];
            quat.fromEuler(sq, rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0);
            mat4.fromRotationTranslation(m, q, t);
            mat4.translate(m, m, [(off[0] ?? 0) * sx, (off[1] ?? 0) * sy, (off[2] ?? 0) * sz]);
            mat4.fromQuat(local, sq);
            mat4.multiply(m, m, local);
            const inverse = mat4.invert(mat4.create(), m);
            if (!inverse) return;
            const [lo, hi] = localBounds(kind, dims, verts);
            const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
            const p = vec3.create();
            for (let k = 0; k < 8; k++) {
                vec3.set(p, k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]);
                vec3.transformMat4(p, p, m);
                for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
            }
            if (area && (max[0] < area[0] || min[0] > area[2] || max[2] < area[1] || min[2] > area[3])) return;
            const key = `${n.id}:${si}:${kind}:${[...Array.from(m), ...dims, ...planes].map(r2).join(',')}`;
            out.push({ kind, inverse, dims, planes, min, max, key, node: n.id });
        });
    }
    return out;
}

/** One string for a list of obstacles: changes when any moves, turns or is resized. */
export function obstaclesKey(list: readonly WaterObstacle[]): string {
    let h = 2166136261;
    for (const o of list) for (let i = 0; i < o.key.length; i++) h = Math.imul(h ^ o.key.charCodeAt(i), 16777619) >>> 0;
    return `${list.length}:${h.toString(36)}`;
}

const _p = vec3.create();

/**
 * Where the vertical line through world (x, z) is inside `o`: [bottom, top] world heights, or null. Convex
 * shapes meet a line in one interval: found by stepping down the shape's height, then bisected to a centimetre.
 */
export function obstacleSpan(o: WaterObstacle, x: number, z: number): [number, number] | null {
    if (x < o.min[0] || x > o.max[0] || z < o.min[2] || z > o.max[2]) return null;
    const at = (y: number) => { vec3.set(_p, x, y, z); vec3.transformMat4(_p, _p, o.inverse); return inside(o, _p); };
    const y0 = o.min[1], y1 = o.max[1];
    const steps = 32;
    let first = -1, last = -1;
    for (let i = 0; i <= steps; i++) {
        if (at(y0 + (y1 - y0) * i / steps)) { if (first < 0) first = i; last = i; }
    }
    if (first < 0) return null;
    const bisect = (outY: number, inY: number) => {
        for (let i = 0; i < 12; i++) { const mid = (outY + inY) / 2; if (at(mid)) inY = mid; else outY = mid; }
        return inY;
    };
    const step = (y1 - y0) / steps;
    const bottom = first === 0 ? y0 : bisect(y0 + (first - 1) * step, y0 + first * step);
    const top = last === steps ? y1 : bisect(y0 + (last + 1) * step, y0 + last * step);
    return [bottom, top];
}

// ---- footprints: what the live waves see of an obstacle ----------------------------------------------------

/**
 * Where an obstacle meets the water, as the live waves (render/waterWaves.ts) take it: its cross-section at
 * the surface, as a rounded rectangle (a disc is one with no straight sides); for one under the surface, the
 * cross-section just under its top, and how far under it is.
 */
export interface WaterObstacleFootprint {
    /** Its centre, world x and z. */
    x: number; z: number;
    /** Its long axis: a unit vector in x and z. */
    ax: number; az: number;
    /** Half its length along that axis and half its width across it, before the rounding (m). */
    a: number; b: number;
    /** The rounding of its corners (m): a disc has a = b = 0 and this its radius. */
    r: number;
    /** Metres its top lies under the surface; 0 for one that stands out of the water. */
    under: number;
}

/** Metres under the surface past which an obstacle no longer shows on it. */
export const FOOTPRINT_DEPTH = 1;
/** Samples a side the cross-section is found with. */
const FOOTPRINT_SAMPLES = 24;
const _q = vec3.create();

/**
 * `o`'s footprint on water whose surface is at `surfaceY`; null when it stands clear of the water (above it,
 * or deeper under it than FOOTPRINT_DEPTH). Upright boxes are taken exactly; round shapes as discs of the area
 * they cut; anything else as the rectangle with the same spread (its second moments).
 */
export function obstacleFootprint(o: WaterObstacle, surfaceY: number): WaterObstacleFootprint | null {
    if (o.min[1] >= surfaceY) return null;
    const under = Math.max(0, surfaceY - o.max[1]);
    if (under > FOOTPRINT_DEPTH) return null;
    // The plane cut: the surface, or just under the top of one beneath it.
    const y = under > 0 ? o.max[1] - Math.min(0.1, 0.25 * (o.max[1] - o.min[1])) : surfaceY;
    const toWorld = mat4.invert(mat4.create(), o.inverse);
    if (!toWorld) return null;
    // An upright box: its own rectangle, if the plane cuts it through its sides.
    if (o.kind === 'box' && Math.abs(toWorld[5]) > 0.995) {
        vec3.set(_q, toWorld[12], y, toWorld[14]);
        vec3.transformMat4(_q, _q, o.inverse);
        if (Math.abs(_q[1]) < o.dims[1]) {
            const len = Math.hypot(toWorld[0], toWorld[2]) || 1;
            let ax = toWorld[0] / len, az = toWorld[2] / len, a = o.dims[0], b = o.dims[2];
            if (b > a) { const t = ax; ax = -az; az = t; a = o.dims[2]; b = o.dims[0]; }
            return { x: toWorld[12], z: toWorld[14], ax, az, a, b, r: 0, under };
        }
    }
    // Anything else: sampled across its bounds at the plane.
    const N = FOOTPRINT_SAMPLES;
    const dx = (o.max[0] - o.min[0]) / N, dz = (o.max[2] - o.min[2]) / N;
    let count = 0, sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const px = o.min[0] + (i + 0.5) * dx, pz = o.min[2] + (j + 0.5) * dz;
        vec3.set(_q, px, y, pz);
        vec3.transformMat4(_q, _q, o.inverse);
        if (!inside(o, _q)) continue;
        count++; sx += px; sz += pz; sxx += px * px; szz += pz * pz; sxz += px * pz;
    }
    if (!count) return null;
    const cx = sx / count, cz = sz / count;
    // The spread, with each sample's own square (dx² / 12) so a footprint a sample wide keeps its width.
    const vxx = Math.max(0, sxx / count - cx * cx) + dx * dx / 12, vzz = Math.max(0, szz / count - cz * cz) + dz * dz / 12;
    const vxz = sxz / count - cx * cz;
    const mid = (vxx + vzz) / 2, half = Math.sqrt(((vxx - vzz) / 2) ** 2 + vxz * vxz);
    const l1 = mid + half, l2 = Math.max(0, mid - half);
    const angle = 0.5 * Math.atan2(2 * vxz, vxx - vzz);
    const ax = Math.cos(angle), az = Math.sin(angle);
    const area = count * dx * dz;
    if ((o.kind === 'sphere' || o.kind === 'cylinder' || o.kind === 'capsule') && l2 > 0.8 * l1)
        return { x: cx, z: cz, ax: 1, az: 0, a: 0, b: 0, r: Math.sqrt(area / Math.PI), under };
    // A uniform rectangle 2a long has a spread of a² / 3 along it.
    return { x: cx, z: cz, ax, az, a: Math.sqrt(3 * l1), b: Math.sqrt(3 * l2), r: 0, under };
}
