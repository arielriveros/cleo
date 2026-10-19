import { Body as CannonBody, ConvexPolyhedron, Shape, Sphere, Box, Vec3 } from 'cannon-es';
import { shapeMassProperties } from './massProperties';

/**
 * Buoyancy and water drag: Archimedes' principle, sampled.
 *
 * Every shape of a dynamic body is represented by a handful of SAMPLE POINTS spread through its volume,
 * each standing for an equal share of it. Each substep, every point below the water surface is pushed up
 * by the weight of the water its share displaces — `density · g · Vᵢ` — AT that point. So:
 *
 *  - whether a body floats, and how low it rides, is nothing but its mass against the water its volume can
 *    displace: a 120 kg crate of 0.5 m³ floats high, a 420 kg chest of 0.12 m³ sinks;
 *  - applying each push where it acts produces the righting torque for free: a log settles flat, a crate
 *    tipped on its edge rolls back onto a face, without a separate "stability" term.
 *
 * The force is applied in the world's `preStep` (after cannon has added gravity, before it integrates),
 * once per substep, so it is integrated exactly like gravity is.
 *
 * Pure apart from the cannon types it reads and the forces it adds — no scene, no nodes — which is what lets
 * tests drive it against a bare world.
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
interface ShapeSamples { points: Vec3[]; weight: number; cell: number; }

const SAMPLE_CACHE = new WeakMap<Shape, ShapeSamples>();

/** Grid resolution along an axis of extent `h` when the longest axis is `longest`: 2..5 points. */
const axisCount = (h: number, longest: number) => Math.max(2, Math.min(5, Math.round(4 * h / Math.max(longest, 1e-6))));

/**
 * Cell-centred grid points over a box `half`, kept by `inside`. Falls back to the centre when the grid
 * misses the shape entirely (a sliver), so every shape with a volume has at least one sample.
 */
function gridSamples(half: Vec3, inside: (p: Vec3) => boolean): Vec3[] {
    const longest = Math.max(half.x, half.y, half.z);
    const nx = axisCount(half.x, longest), ny = axisCount(half.y, longest), nz = axisCount(half.z, longest);
    const out: Vec3[] = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
        const p = new Vec3(
            -half.x + (2 * half.x * (i + 0.5)) / nx,
            -half.y + (2 * half.y * (j + 0.5)) / ny,
            -half.z + (2 * half.z * (k + 0.5)) / nz,
        );
        if (inside(p)) out.push(p);
    }
    return out.length ? out : [new Vec3()];
}

/** The sample points of one shape, computed once per shape object. */
export function shapeSamples(shape: Shape): ShapeSamples | null {
    const cached = SAMPLE_CACHE.get(shape);
    if (cached) return cached;
    const { volume, centroid } = shapeMassProperties(shape);
    if (!(volume > 0)) return null;

    let points: Vec3[];
    if (shape.type === Shape.types.SPHERE) {
        const r = (shape as Sphere).radius;
        points = gridSamples(new Vec3(r, r, r), p => p.lengthSquared() <= r * r);
    } else if (shape.type === Shape.types.BOX) {
        points = gridSamples((shape as Box).halfExtents, () => true);
    } else if (shape.type === Shape.types.CONVEXPOLYHEDRON || shape.type === Shape.types.CYLINDER) {
        const hull = shape as ConvexPolyhedron;
        if (!hull.faceNormals?.length) hull.computeNormals();
        const min = new Vec3(Infinity, Infinity, Infinity), max = new Vec3(-Infinity, -Infinity, -Infinity);
        for (const v of hull.vertices) {
            min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
            max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
        }
        const mid = new Vec3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
        const half = new Vec3((max.x - min.x) / 2, (max.y - min.y) / 2, (max.z - min.z) / 2);
        const d = new Vec3();
        const inside = (p: Vec3) => {
            for (let f = 0; f < hull.faces.length; f++) {
                hull.vertices[hull.faces[f][0]].vsub(p, d);
                // Outward normals: a point is inside when it is behind every face plane.
                if (hull.faceNormals[f].dot(d) < -1e-9) return false;
            }
            return true;
        };
        points = gridSamples(half, p => { const q = p.vadd(mid); return inside(q); }).map(p => p.vadd(mid));
        // Whatever the grid kept, centre it on the hull's true centroid so the samples' mean is the shape's
        // centre of buoyancy at full submersion.
        const mean = new Vec3();
        for (const p of points) mean.vadd(p, mean);
        mean.scale(1 / points.length, mean);
        const shift = centroid.vsub(mean);
        points = points.map(p => p.vadd(shift));
    } else {
        return null;
    }
    const weight = volume / points.length;
    const samples = { points, weight, cell: Math.cbrt(weight) };
    SAMPLE_CACHE.set(shape, samples);
    return samples;
}

/** Whether a body is something water should push: dynamic, solid, and (unless asked) not a character. */
export function floats(body: CannonBody, volume: BuoyancyVolume, isCharacter: (body: CannonBody) => boolean): boolean {
    if (body.type !== CannonBody.DYNAMIC || !(body.mass > 0)) return false;
    if ((body as any).isTrigger || body.collisionResponse === false) return false;
    if (!volume.affectCharacters && isCharacter(body)) return false;
    return true;
}

const _local = new Vec3(), _world = new Vec3(), _rel = new Vec3(), _force = new Vec3();

/**
 * Apply one substep of buoyancy and drag from `volume` to `body`. `gravity` is the world's magnitude
 * (positive), `dt` the substep. Returns the submerged fraction of the body's volume (0..1).
 */
export function applyBuoyancy(body: CannonBody, volume: BuoyancyVolume, gravity: number, dt: number): number {
    // Cheap reject first: the body's bounds must overlap the water box at all.
    body.updateAABB();
    const lo = body.aabb.lowerBound, hi = body.aabb.upperBound;
    if (hi.x < volume.min[0] || lo.x > volume.max[0] || hi.z < volume.min[2] || lo.z > volume.max[2]) return 0;
    if (lo.y > volume.max[1] + 2 || hi.y < volume.min[1]) return 0;

    let total = 0, submerged = 0;
    for (let s = 0; s < body.shapes.length; s++) {
        const samples = shapeSamples(body.shapes[s]);
        if (!samples) continue;
        const offset = body.shapeOffsets[s], orientation = body.shapeOrientations[s];
        for (const p of samples.points) {
            total += samples.weight;
            // shape-local -> body-local -> world.
            orientation.vmult(p, _local);
            _local.vadd(offset, _local);
            body.quaternion.vmult(_local, _rel);
            body.position.vadd(_rel, _world);
            if (_world.x < volume.min[0] || _world.x > volume.max[0] || _world.z < volume.min[2] || _world.z > volume.max[2]) continue;
            if (_world.y < volume.min[1]) continue;
            const surface = volume.surfaceAt ? volume.surfaceAt(_world.x, _world.z) : volume.max[1];
            // Each point stands for a slab `cell` thick, so it goes under GRADUALLY as the surface crosses
            // it. A point that switched on and off at the surface made the force a staircase in depth —
            // a floating body never found a level, it chattered between two steps for ever.
            const wet = Math.min(1, Math.max(0, (surface - _world.y) / samples.cell + 0.5));
            if (wet <= 0) continue;
            const displaced = samples.weight * wet;
            submerged += displaced;
            _force.set(0, volume.density * gravity * displaced, 0);
            body.applyForce(_force, _rel);
        }
    }
    if (!(total > 0) || submerged <= 0) return 0;
    const fraction = Math.min(1, submerged / total);

    // Drag, proportional to how much of the body is in the water. Linear as a force (so a heavy body is
    // slowed no faster than a light one of the same shape would be in proportion), angular as a damping
    // factor on the velocity — clamped so a long substep can never reverse a spin.
    const k = volume.linearDrag * fraction * body.mass;
    _force.set(-body.velocity.x * k, -body.velocity.y * k, -body.velocity.z * k);
    body.applyForce(_force);
    const spin = Math.max(0, 1 - volume.angularDrag * fraction * dt);
    body.angularVelocity.scale(spin, body.angularVelocity);
    return fraction;
}
