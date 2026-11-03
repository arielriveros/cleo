import type { BodyHandle, ConvexHull, PartShape } from './pal/types';
import type { PhysicsWorld } from './pal/world';
import { rotateVec } from './pal/math';

/**
 * Buoyancy and water drag: Archimedes' principle, sampled.
 *
 * Every collider part of a dynamic body (as its backend simulates it, see pal/types.ts ColliderPart) is
 * represented by a handful of SAMPLE POINTS spread through its volume,
 * each standing for an equal share of it. Each substep, every point below the water surface is pushed up
 * by the weight of the water its share displaces — `density · g · Vᵢ` — AT that point. So:
 *
 *  - whether a body floats, and how low it rides, is nothing but its mass against the water its volume can
 *    displace: a 120 kg crate of 0.5 m³ floats high, a 420 kg chest of 0.12 m³ sinks;
 *  - applying each push where it acts produces the righting torque for free: a log settles flat, a crate
 *    tipped on its edge rolls back onto a face, without a separate "stability" term.
 *
 * The force is applied in the world's pre-substep hook (PhysicsWorld.onPreSubstep: before the solver),
 * once per substep, so it is integrated exactly like gravity is.
 *
 * Pure apart from the world it reads and the forces it adds — no scene, no nodes — which is what lets tests
 * drive it against a bare world.
 */

/** What one water volume tells the solver. Axis-aligned in world space. */
export interface BuoyancyVolume {
    /** World-space box of the water body: `max[1]` is the resting surface, `min[1]` its floor. */
    min: readonly [number, number, number];
    max: readonly [number, number, number];
    /** kg/m³. Fresh water 1000, sea water 1025. */
    density: number;
    /** Per second: linear velocity drag at full submersion (scaled by the submerged fraction). */
    linearDrag: number;
    /** Per second: angular velocity damping at full submersion. */
    angularDrag: number;
    /** Surface height at a world x/z, for a surface that waves. Defaults to the flat `max[1]`. */
    surfaceAt?: (x: number, z: number) => number;
    /** Whether bodies owned by characters are affected. Off: a character capsule is mostly air. */
    affectCharacters?: boolean;
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

/**
 * Apply one substep of buoyancy and drag from `volume` to the body `h` of `world`, whose mass is `mass`.
 * `gravity` is the world's magnitude (positive), `dt` the substep. Returns the submerged fraction of the
 * body's volume (0..1).
 */
export function applyBuoyancy(world: BuoyancyWorld, h: BodyHandle, mass: number, volume: BuoyancyVolume, gravity: number, dt: number): number {
    // Cheap reject first: the body's bounds must overlap the water box at all.
    world.getAabb(h, _aabb);
    if (_aabb[3] < volume.min[0] || _aabb[0] > volume.max[0] || _aabb[5] < volume.min[2] || _aabb[2] > volume.max[2]) return 0;
    if (_aabb[1] > volume.max[1] + 2 || _aabb[4] < volume.min[1]) return 0;

    // Parts are placed in the collider frame, and a force's point is measured from the centre of mass: the
    // same point when the frame IS the centre of mass (cannon). A backend whose frame is the node origin
    // would need the offset between the two added here.
    world.getColliderFrame(h, _frame);
    let total = 0, submerged = 0;
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
            if (wx < volume.min[0] || wx > volume.max[0] || wz < volume.min[2] || wz > volume.max[2]) continue;
            if (wy < volume.min[1]) continue;
            const surface = volume.surfaceAt ? volume.surfaceAt(wx, wz) : volume.max[1];
            // Each point stands for a slab `cell` thick, so it goes under GRADUALLY as the surface crosses
            // it. A point that switched on and off at the surface made the force a staircase in depth —
            // a floating body never found a level, it chattered between two steps for ever.
            const wet = Math.min(1, Math.max(0, (surface - wy) / samples.cell + 0.5));
            if (wet <= 0) continue;
            const displaced = samples.weight * wet;
            submerged += displaced;
            _force[0] = 0; _force[1] = volume.density * gravity * displaced; _force[2] = 0;
            world.applyForce(h, _force, _rel);
        }
    }
    if (!(total > 0) || submerged <= 0) return 0;
    const fraction = Math.min(1, submerged / total);

    // Drag, proportional to how much of the body is in the water. Linear as a force (so a heavy body is
    // slowed no faster than a light one of the same shape would be in proportion), angular as a damping
    // factor on the velocity — clamped so a long substep can never reverse a spin.
    world.getVelocity(h, _velocity);
    const k = volume.linearDrag * fraction * mass;
    _force[0] = -_velocity[0] * k; _force[1] = -_velocity[1] * k; _force[2] = -_velocity[2] * k;
    world.applyForce(h, _force);
    const spin = Math.max(0, 1 - volume.angularDrag * fraction * dt);
    world.setAngularVelocity(h, spin * _velocity[3], spin * _velocity[4], spin * _velocity[5]);
    return fraction;
}
