import type { BodyHandle, ConvexHull, PartShape } from './pal/types';
import type { PhysicsWorld } from './pal/world';
import { rotateVec } from './pal/math';

/**
 * Buoyancy and water drag: Archimedes' principle, sampled, with the water's own motion.
 *
 * Every collider part of a dynamic body (as its backend simulates it, see pal/types.ts ColliderPart) is
 * represented by a handful of SAMPLE POINTS spread through its volume, each standing for an equal share
 * of it. Each substep, at every point below the water surface:
 *
 *  - PRESSURE pushes on its share, `density · g · Vᵢ`, AT that point, and along the water's slope rather
 *    than straight up: the pressure under a sloped surface rises toward the higher side, so a body is
 *    pushed down a wave's face and down a river's gradient (the Froude–Krylov force of naval architecture,
 *    under the hydrostatic approximation). How much of a wave's push is left falls with depth, as the
 *    wave's own motion does (e^(-k·depth));
 *  - DRAG pulls the point toward the water's velocity there: the current, plus the waves' orbital motion
 *    (forward on a crest, back in a trough, fading with depth), so what floats rides the waves rather than
 *    fighting them. Linear (`linearDrag` per second, for the water a body displaces) plus form drag growing
 *    with the square of the speed (drag coefficient 1), both for the water displaced, not the body's mass:
 *    a heavy chest sinks through water that a light crate settles in. Applied where each point is, so a
 *    spinning body is slowed by the water too.
 *
 * So whether a body floats, and how low it rides, is nothing but its mass against the water its volume can
 * displace; applying each push where it acts rights a tipped log for free; and floaters ride the very waves
 * the renderer draws.
 *
 * Where two waters overlap (a river running into its lake) each point is in ONE of them: the one the other
 * gives way to (`yieldsTo`), else the higher surface. The water is sampled once per body per substep, on a
 * 3 × 3 patch over its footprint (height, slope and motion), and the points read that patch.
 *
 * The forces are applied in the world's pre-substep hook (PhysicsWorld.onPreSubstep: before the solver),
 * once per substep, so they are integrated exactly like gravity is.
 *
 * Pure apart from the world it reads and the forces it adds — no scene, no nodes — which is what lets tests
 * drive it against a bare world.
 */

/** The water over one XZ point, as {@link BuoyancyVolume.columnAt} reports it. */
export interface WaterColumnSample {
    /** Surface height there, waves included. */
    surface: number;
    /** Bed height: a point below it is under the water's floor, not in it. */
    floor: number;
    /** Water velocity (m/s) in world XZ: bodies are dragged toward it, so a river carries them. */
    flowX: number;
    flowZ: number;
    /** The surface before the waves (its slope is a river's gradient). Defaults to `surface`. */
    rest?: number;
    /** The waves' motion of the water at the surface (m/s), and the wavenumber it fades with below. */
    waveVX?: number; waveVY?: number; waveVZ?: number; waveK?: number;
}

/** What one water volume tells the solver. Axis-aligned in world space. */
export interface BuoyancyVolume {
    /** The water's id, for {@link yieldsTo}. */
    id?: string;
    /** Waters (ids) this one gives way to where both are: a river to the lake it runs into. */
    yieldsTo?: readonly string[];
    /** World-space box of the water body: `max[1]` is the resting surface, `min[1]` its floor. */
    min: readonly [number, number, number];
    max: readonly [number, number, number];
    /** kg/m³. Fresh water 1000, sea water 1025. */
    density: number;
    /**
     * Per second: linear drag toward the water's velocity, for the water a body displaces (a body as dense
     * as the water, fully under, takes on the water's speed at this rate).
     */
    linearDrag: number;
    /** Per second: extra spin damping at full submersion, over what the water's drag on each point gives. */
    angularDrag: number;
    /** Surface height at a world x/z, for a surface that waves. Defaults to the flat `max[1]`. */
    surfaceAt?: (x: number, z: number) => number;
    /** Whether bodies owned by characters are affected. Off: a character capsule is mostly air. */
    affectCharacters?: boolean;
    /**
     * Water of any shape inside the box: the column over a world x/z, or null where there is no water.
     * When set it replaces `surfaceAt` and the box's own top and floor (the box stays the cheap reject).
     * The returned object may be reused by the next call.
     */
    columnAt?: (x: number, z: number) => WaterColumnSample | null;
}

/**
 * Per-shape sample points in SHAPE-LOCAL space, the volume each one stands for, and the thickness of the
 * slab of water it represents (the cube root of that volume).
 */
interface ShapeSamples { points: number[][]; weight: number; cell: number; }

const SAMPLE_CACHE = new WeakMap<PartShape, ShapeSamples>();

/** Grid resolution along an axis of extent `h` when the longest axis is `longest`: 2..5 points. */
const axisCount = (h: number, longest: number) => Math.max(2, Math.min(5, Math.round(4 * h / Math.max(longest, 1e-6))));

/**
 * Cell-centred grid points over a box `half`, kept by `inside`. Falls back to the centre when the grid
 * misses the shape entirely (a sliver), so every shape with a volume has at least one sample.
 */
function gridSamples(half: readonly number[], inside: (p: number[]) => boolean): number[][] {
    const longest = Math.max(half[0], half[1], half[2]);
    const nx = axisCount(half[0], longest), ny = axisCount(half[1], longest), nz = axisCount(half[2], longest);
    const out: number[][] = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
        const p = [
            -half[0] + (2 * half[0] * (i + 0.5)) / nx,
            -half[1] + (2 * half[1] * (j + 0.5)) / ny,
            -half[2] + (2 * half[2] * (k + 0.5)) / nz,
        ];
        if (inside(p)) out.push(p);
    }
    return out.length ? out : [[0, 0, 0]];
}

/**
 * Volume and centroid of a closed convex polyhedron, by tetrahedron decomposition about the shape origin:
 * each face is fanned into triangles and each triangle forms a tetrahedron with the origin. The signed sum
 * is exact, and stays correct even when the origin lies outside the hull, provided the faces are
 * consistently wound.
 */
function hullMass(hull: ConvexHull): { volume: number; centroid: number[] } {
    const v = hull.vertices;
    let volume = 0;
    let cx = 0, cy = 0, cz = 0;
    for (const face of hull.faces) {
        for (let i = 1; i + 1 < face.length; i++) {
            const a = v[face[0]], b = v[face[i]], c = v[face[i + 1]];
            // dot(a, cross(b, c)) — six times the signed tetrahedron volume.
            const sixV =
                a[0] * (b[1] * c[2] - b[2] * c[1]) +
                a[1] * (b[2] * c[0] - b[0] * c[2]) +
                a[2] * (b[0] * c[1] - b[1] * c[0]);
            volume += sixV;
            // A tetrahedron's centroid is the mean of its four corners, one of which is the origin.
            cx += sixV * (a[0] + b[0] + c[0]);
            cy += sixV * (a[1] + b[1] + c[1]);
            cz += sixV * (a[2] + b[2] + c[2]);
        }
    }
    if (!isFinite(volume) || Math.abs(volume) < 1e-12) return { volume: 0, centroid: [0, 0, 0] };
    const scale = 1 / (4 * volume);
    return { volume: Math.abs(volume) / 6, centroid: [cx * scale, cy * scale, cz * scale] };
}

/** Samples over a convex hull, centred on its true centroid. */
function hullSamples(hull: ConvexHull): { points: number[][]; volume: number } | null {
    const { volume, centroid } = hullMass(hull);
    if (!(volume > 0)) return null;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const v of hull.vertices) {
        min[0] = Math.min(min[0], v[0]); min[1] = Math.min(min[1], v[1]); min[2] = Math.min(min[2], v[2]);
        max[0] = Math.max(max[0], v[0]); max[1] = Math.max(max[1], v[1]); max[2] = Math.max(max[2], v[2]);
    }
    const mid = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const half = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
    const inside = (p: number[]) => {
        for (let f = 0; f < hull.faces.length; f++) {
            const v = hull.vertices[hull.faces[f][0]], n = hull.normals[f];
            // Outward normals: a point is inside when it is behind every face plane.
            if (n[0] * (v[0] - p[0]) + n[1] * (v[1] - p[1]) + n[2] * (v[2] - p[2]) < -1e-9) return false;
        }
        return true;
    };
    const plus = (p: number[], q: readonly number[]) => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
    let points = gridSamples(half, p => inside(plus(p, mid))).map(p => plus(p, mid));
    // Whatever the grid kept, centre it on the hull's true centroid so the samples' mean is the shape's
    // centre of buoyancy at full submersion.
    const mean = [0, 0, 0];
    for (const p of points) { mean[0] = p[0] + mean[0]; mean[1] = p[1] + mean[1]; mean[2] = p[2] + mean[2]; }
    const s = 1 / points.length;
    mean[0] = s * mean[0]; mean[1] = s * mean[1]; mean[2] = s * mean[2];
    const shift = [centroid[0] - mean[0], centroid[1] - mean[1], centroid[2] - mean[2]];
    points = points.map(p => plus(p, shift));
    return { points, volume };
}

/** The sample points of one collider part's shape, computed once per shape. Null for one with no volume. */
export function shapeSamples(shape: PartShape): ShapeSamples | null {
    const cached = SAMPLE_CACHE.get(shape);
    if (cached) return cached;

    let points: number[][], volume: number;
    if (shape.kind === 'sphere') {
        const r = shape.radius;
        volume = (4 / 3) * Math.PI * r * r * r;
        points = gridSamples([r, r, r], p => p[0] * p[0] + p[1] * p[1] + p[2] * p[2] <= r * r);
    } else if (shape.kind === 'box') {
        const h = shape.halfExtents;
        volume = 8 * h[0] * h[1] * h[2];
        points = gridSamples(h, () => true);
    } else if (shape.kind === 'convex' || (shape.kind === 'cylinder' && shape.hull)) {
        // A cylinder the backend simulates as a polyhedron (cannon) is sampled as that polyhedron.
        const hull = shape.kind === 'convex' ? shape.hull : shape.hull!;
        const s = hullSamples(hull);
        if (!s) return null;
        points = s.points; volume = s.volume;
    } else if (shape.kind === 'cylinder') {
        const r = Math.max(shape.radiusTop, shape.radiusBottom), h = shape.height / 2;
        const r1 = shape.radiusBottom, r2 = shape.radiusTop;
        volume = Math.PI * shape.height / 3 * (r1 * r1 + r1 * r2 + r2 * r2);
        points = gridSamples([r, h, r], p => {
            const at = r1 + (r2 - r1) * (p[1] + h) / (2 * h || 1);
            return p[0] * p[0] + p[2] * p[2] <= at * at;
        });
    } else if (shape.kind === 'capsule') {
        const r = shape.radius, h = shape.height / 2;
        volume = Math.PI * r * r * shape.height + (4 / 3) * Math.PI * r * r * r;
        points = gridSamples([r, h + r, r], p => {
            const y = Math.max(-h, Math.min(h, p[1]));
            return p[0] * p[0] + (p[1] - y) * (p[1] - y) + p[2] * p[2] <= r * r;
        });
    } else {
        // Plane, heightfield, trimesh: no volume to displace water with.
        return null;
    }
    if (!(volume > 0)) return null;
    const weight = volume / points.length;
    const samples = { points, weight, cell: Math.cbrt(weight) };
    SAMPLE_CACHE.set(shape, samples);
    return samples;
}

/** What {@link floats} reads from a body. The caller has already checked it is dynamic. */
export interface Floater {
    mass: number;
    isTrigger?: boolean;
    collisionResponse?: boolean;
}

/** Whether a dynamic body is something water should push: solid, with mass, and (unless asked) not a character. */
export function floats<T extends Floater>(body: T, volume: BuoyancyVolume, isCharacter: (body: T) => boolean): boolean {
    if (!(body.mass > 0)) return false;
    if (body.isTrigger || body.collisionResponse === false) return false;
    if (!volume.affectCharacters && isCharacter(body)) return false;
    return true;
}

/** What buoyancy needs from the world a body is in. */
export type BuoyancyWorld = Pick<PhysicsWorld, 'getAabb' | 'getColliderFrame' | 'colliderParts' | 'applyForce' | 'getVelocity' | 'setAngularVelocity'>;

const _aabb = new Float64Array(6), _frame = new Float64Array(7), _velocity = new Float64Array(6);
const _local = new Float64Array(3), _rel = new Float64Array(3), _force = new Float64Array(3);

/** The water over one node of a body's patch: what is there, and whose. */
interface PatchNode {
    wet: boolean;
    surface: number; rest: number; floor: number;
    flowX: number; flowZ: number;
    waveVX: number; waveVY: number; waveVZ: number; waveK: number;
    /** Index of the volume it belongs to. */
    volume: number;
}

const PATCH = 3;
const _patch: PatchNode[] = Array.from({ length: PATCH * PATCH }, () => ({
    wet: false, surface: 0, rest: 0, floor: 0, flowX: 0, flowZ: 0, waveVX: 0, waveVY: 0, waveVZ: 0, waveK: 0, volume: -1,
}));
const _candidates: { volume: number; sample: WaterColumnSample }[] = Array.from({ length: 8 }, () => ({
    volume: -1, sample: { surface: 0, floor: 0, flowX: 0, flowZ: 0 } as WaterColumnSample,
}));
/** Form drag coefficient: a bluff body in a flow. */
const DRAG_COEFFICIENT = 1;
/** Drag may at most take away this share of a body's speed relative to the water in one substep (stability). */
const MAX_DRAG_PER_STEP = 0.8;
/** Per-point drag forces of one body, gathered before they are applied (clamped as a whole): [fx, fy, fz, px, py, pz]. */
let _drag = new Float64Array(6 * 256);
const _submerged = new Float64Array(16);

function columnOf(v: BuoyancyVolume, x: number, z: number, out: WaterColumnSample): boolean {
    if (x < v.min[0] || x > v.max[0] || z < v.min[2] || z > v.max[2]) return false;
    if (v.columnAt) {
        const c = v.columnAt(x, z);
        if (!c) return false;
        out.surface = c.surface; out.floor = c.floor; out.flowX = c.flowX; out.flowZ = c.flowZ;
        out.rest = c.rest ?? c.surface;
        out.waveVX = c.waveVX ?? 0; out.waveVY = c.waveVY ?? 0; out.waveVZ = c.waveVZ ?? 0; out.waveK = c.waveK ?? 0;
        return true;
    }
    out.surface = v.surfaceAt ? v.surfaceAt(x, z) : v.max[1];
    out.rest = v.max[1]; out.floor = v.min[1];
    out.flowX = 0; out.flowZ = 0; out.waveVX = 0; out.waveVY = 0; out.waveVZ = 0; out.waveK = 0;
    return true;
}

/** Metres the joined water may stand below a water's own surface and still be the water there. */
const YIELD_BELOW = 0.05;

/** The one water at (x, z) among `volumes` into `node` (see the header: whose water a point is in). */
function waterAt(volumes: readonly BuoyancyVolume[], x: number, z: number, node: PatchNode): void {
    let n = 0;
    for (let i = 0; i < volumes.length && n < _candidates.length; i++) {
        if (columnOf(volumes[i], x, z, _candidates[n].sample)) { _candidates[n].volume = i; n++; }
    }
    node.wet = false;
    let best = -1;
    for (let a = 0; a < n; a++) {
        const va = volumes[_candidates[a].volume];
        let yields = false;
        if (va.yieldsTo && va.yieldsTo.length) {
            // A water gives way to the water it joins only where that water really stands: at its own level
            // or above. A river still running down toward a lake or the sea far below it is the water there.
            const own = _candidates[a].sample.rest ?? _candidates[a].sample.surface;
            for (let b = 0; b < n && !yields; b++) {
                const id = volumes[_candidates[b].volume].id;
                if (b === a || id === undefined || !va.yieldsTo.includes(id)) continue;
                const other = _candidates[b].sample.rest ?? _candidates[b].sample.surface;
                if (other >= own - YIELD_BELOW) yields = true;
            }
        }
        if (yields) continue;
        if (best < 0 || _candidates[a].sample.surface >= _candidates[best].sample.surface) best = a;
    }
    if (best < 0) return;
    const c = _candidates[best].sample;
    node.wet = true; node.volume = _candidates[best].volume;
    node.surface = c.surface; node.rest = c.rest ?? c.surface; node.floor = c.floor;
    node.flowX = c.flowX; node.flowZ = c.flowZ;
    node.waveVX = c.waveVX ?? 0; node.waveVY = c.waveVY ?? 0; node.waveVZ = c.waveVZ ?? 0; node.waveK = c.waveK ?? 0;
}

/**
 * Apply one substep of buoyancy and drag from the water in `volumes` (one volume, or several that may
 * overlap) to the body `h` of `world`, whose mass is `mass`. `gravity` is the world's magnitude (positive),
 * `dt` the substep. Returns the submerged fraction of the body's volume (0..1); `report`, when given, hears
 * each volume's share of it (by index into `volumes`).
 */
export function applyBuoyancy(world: BuoyancyWorld, h: BodyHandle, mass: number, volumes: BuoyancyVolume | readonly BuoyancyVolume[],
                              gravity: number, dt: number, report?: (volume: number, fraction: number) => void): number {
    const list: readonly BuoyancyVolume[] = Array.isArray(volumes) ? volumes : [volumes as BuoyancyVolume];
    // Cheap reject first: the body's bounds must overlap some water box at all.
    world.getAabb(h, _aabb);
    let any = false;
    for (const v of list) {
        if (_aabb[3] < v.min[0] || _aabb[0] > v.max[0] || _aabb[5] < v.min[2] || _aabb[2] > v.max[2]) continue;
        if (_aabb[1] > v.max[1] + 2 || _aabb[4] < v.min[1]) continue;
        any = true;
    }
    if (!any) return 0;

    // The water under the body: a 3 x 3 patch over its footprint.
    const x0 = _aabb[0], z0 = _aabb[2];
    const dx = (_aabb[3] - _aabb[0]) / (PATCH - 1), dz = (_aabb[5] - _aabb[2]) / (PATCH - 1);
    let wetNodes = 0;
    for (let j = 0; j < PATCH; j++) for (let i = 0; i < PATCH; i++) {
        const node = _patch[j * PATCH + i];
        waterAt(list, x0 + i * dx, z0 + j * dz, node);
        if (node.wet) wetNodes++;
    }
    if (!wetNodes) return 0;

    // Parts are placed in the collider frame, and a force's point is measured from the centre of mass: the
    // same point when the frame IS the centre of mass (cannon). A backend whose frame is the node origin
    // would need the offset between the two added here.
    world.getColliderFrame(h, _frame);
    world.getVelocity(h, _velocity);
    let total = 0, submerged = 0, dragCount = 0, dragSum = 0;
    const nv = Math.min(list.length, _submerged.length);
    for (let i = 0; i < nv; i++) _submerged[i] = 0;
    for (const part of world.colliderParts(h)) {
        const samples = shapeSamples(part.shape);
        if (!samples) continue;
        const offset = part.offset, orientation = part.rotation;
        for (const p of samples.points) {
            total += samples.weight;
            // shape-local -> body-local -> world.
            rotateVec(orientation, 0, p[0], p[1], p[2], _local);
            _local[0] = offset[0] + _local[0]; _local[1] = offset[1] + _local[1]; _local[2] = offset[2] + _local[2];
            rotateVec(_frame, 3, _local[0], _local[1], _local[2], _rel);
            const wx = _rel[0] + _frame[0], wy = _rel[1] + _frame[1], wz = _rel[2] + _frame[2];

            // The patch cell the point is over, and where in it.
            const u = dx > 1e-6 ? Math.min(PATCH - 1, Math.max(0, (wx - x0) / dx)) : 0;
            const v = dz > 1e-6 ? Math.min(PATCH - 1, Math.max(0, (wz - z0) / dz)) : 0;
            const ci = Math.min(PATCH - 2, Math.floor(u)), cj = Math.min(PATCH - 2, Math.floor(v));
            const fu = u - ci, fv = v - cj;
            const n00 = _patch[cj * PATCH + ci], n10 = _patch[cj * PATCH + ci + 1];
            const n01 = _patch[(cj + 1) * PATCH + ci], n11 = _patch[(cj + 1) * PATCH + ci + 1];
            let surface: number, rest: number, floor: number, fx: number, fz: number, wvx: number, wvy: number, wvz: number, k: number;
            let slopeX = 0, slopeZ = 0, restSlopeX = 0, restSlopeZ = 0, volume: number;
            if (n00.wet && n10.wet && n01.wet && n11.wet) {
                const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
                const lerp = (a: number, b: number, c: number, d: number) => a * w00 + b * w10 + c * w01 + d * w11;
                surface = lerp(n00.surface, n10.surface, n01.surface, n11.surface);
                rest = lerp(n00.rest, n10.rest, n01.rest, n11.rest);
                floor = lerp(n00.floor, n10.floor, n01.floor, n11.floor);
                fx = lerp(n00.flowX, n10.flowX, n01.flowX, n11.flowX); fz = lerp(n00.flowZ, n10.flowZ, n01.flowZ, n11.flowZ);
                wvx = lerp(n00.waveVX, n10.waveVX, n01.waveVX, n11.waveVX);
                wvy = lerp(n00.waveVY, n10.waveVY, n01.waveVY, n11.waveVY);
                wvz = lerp(n00.waveVZ, n10.waveVZ, n01.waveVZ, n11.waveVZ);
                k = lerp(n00.waveK, n10.waveK, n01.waveK, n11.waveK);
                // The surface's slope across the cell: the bilinear patch's own derivative.
                if (dx > 1e-6) {
                    slopeX = ((n10.surface - n00.surface) * (1 - fv) + (n11.surface - n01.surface) * fv) / dx;
                    restSlopeX = ((n10.rest - n00.rest) * (1 - fv) + (n11.rest - n01.rest) * fv) / dx;
                }
                if (dz > 1e-6) {
                    slopeZ = ((n01.surface - n00.surface) * (1 - fu) + (n11.surface - n10.surface) * fu) / dz;
                    restSlopeZ = ((n01.rest - n00.rest) * (1 - fu) + (n11.rest - n10.rest) * fu) / dz;
                }
                volume = (fu < 0.5 ? (fv < 0.5 ? n00 : n01) : (fv < 0.5 ? n10 : n11)).volume;
            } else {
                // At the water's edge: the nearest corner that has water, flat.
                const near = (fu < 0.5 ? (fv < 0.5 ? [n00, n01, n10, n11] : [n01, n00, n11, n10]) : (fv < 0.5 ? [n10, n11, n00, n01] : [n11, n10, n01, n00])).find(n => n.wet);
                if (!near) continue;
                surface = near.surface; rest = near.rest; floor = near.floor; fx = near.flowX; fz = near.flowZ;
                wvx = near.waveVX; wvy = near.waveVY; wvz = near.waveVZ; k = near.waveK; volume = near.volume;
            }
            if (wy < floor) continue;
            // Each point stands for a slab `cell` thick, so it goes under GRADUALLY as the surface crosses
            // it. A point that switched on and off at the surface made the force a staircase in depth —
            // a floating body never found a level, it chattered between two steps for ever.
            const wet = Math.min(1, Math.max(0, (surface - wy) / samples.cell + 0.5));
            if (wet <= 0) continue;
            const displaced = samples.weight * wet;
            submerged += displaced;
            if (volume >= 0 && volume < nv) _submerged[volume] += displaced;
            const water = list[volume] ?? list[0];
            const rho = water.density;
            // The waves' push and motion fade below the surface as their orbits do.
            const decay = k > 0 ? Math.exp(-k * Math.max(0, surface - wy)) : 1;

            // Pressure: up, and down the slope (the river's in full, the waves' fading with depth).
            const lift = rho * gravity * displaced;
            const sx = restSlopeX + (slopeX - restSlopeX) * decay, sz = restSlopeZ + (slopeZ - restSlopeZ) * decay;
            _force[0] = -lift * sx; _force[1] = lift; _force[2] = -lift * sz;
            world.applyForce(h, _force, _rel);

            // Drag toward the water's motion at the point: the current, and the waves' orbits.
            const pvx = _velocity[0] + _velocity[4] * _rel[2] - _velocity[5] * _rel[1];
            const pvy = _velocity[1] + _velocity[5] * _rel[0] - _velocity[3] * _rel[2];
            const pvz = _velocity[2] + _velocity[3] * _rel[1] - _velocity[4] * _rel[0];
            const rx = pvx - (fx + wvx * decay), ry = pvy - wvy * decay, rz = pvz - (fz + wvz * decay);
            const speed = Math.hypot(rx, ry, rz);
            const c = rho * displaced * (water.linearDrag + 0.5 * DRAG_COEFFICIENT * speed / samples.cell);
            if (dragCount * 6 + 6 > _drag.length) { const grown = new Float64Array(_drag.length * 2); grown.set(_drag); _drag = grown; }
            const o = dragCount * 6;
            _drag[o] = -c * rx; _drag[o + 1] = -c * ry; _drag[o + 2] = -c * rz;
            _drag[o + 3] = _rel[0]; _drag[o + 4] = _rel[1]; _drag[o + 5] = _rel[2];
            dragCount++;
            dragSum += c;
        }
    }
    if (!(total > 0) || submerged <= 0) return 0;
    const fraction = Math.min(1, submerged / total);

    // The drag, all at once: explicit, so never more than takes most of the relative speed in one substep.
    const limit = mass > 0 && dt > 0 ? MAX_DRAG_PER_STEP * mass / dt : Infinity;
    const scale = dragSum > limit ? limit / dragSum : 1;
    for (let i = 0; i < dragCount; i++) {
        const o = i * 6;
        _force[0] = _drag[o] * scale; _force[1] = _drag[o + 1] * scale; _force[2] = _drag[o + 2] * scale;
        _rel[0] = _drag[o + 3]; _rel[1] = _drag[o + 4]; _rel[2] = _drag[o + 5];
        world.applyForce(h, _force, _rel);
    }
    // Extra spin damping, as authored: a factor on the spin, clamped so a long substep never reverses it.
    const angularDrag = list[0].angularDrag;
    if (angularDrag > 0) {
        const spin = Math.max(0, 1 - angularDrag * fraction * dt);
        world.getVelocity(h, _velocity);
        world.setAngularVelocity(h, spin * _velocity[3], spin * _velocity[4], spin * _velocity[5]);
    }
    if (report) for (let i = 0; i < nv; i++) if (_submerged[i] > 0) report(i, Math.min(1, _submerged[i] / total));
    return fraction;
}
