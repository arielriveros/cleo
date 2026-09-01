import { Shape, Box, Sphere, ConvexPolyhedron, Vec3, Quaternion } from 'cannon-es';

// ---------------------------------------------------------------------------
// Mass properties of cannon shapes.
//
// cannon-es has NO centre-of-mass concept: `body.position` IS the centre of mass. Shape offsets move
// collision geometry only, so a collider authored with an offset leaves the mass at the body origin with
// the geometry hanging off it. Gravity then applies no torque (it acts at the origin) but the ground's
// normal force does, with a lever arm equal to the offset — so the body rotates until the
// origin->collider vector lines up with the contact normal. That is the "everything tilts to match the
// terrain" bug.
//
// This module supplies the correction: where the mass actually is, so `CBody.recenterMass` can re-base
// the shapes onto it. Pure maths over cannon shapes — no scene or engine imports, so vitest can drive it.
// ---------------------------------------------------------------------------

/** Volume and local centroid of one shape, in the shape's own frame. */
export interface ShapeMass {
    /** Zero for shapes that bound no volume (Plane, Heightfield, Trimesh, Particle) — callers skip those. */
    volume: number;
    /** Centre of volume. Zero for every primitive; only a convex hull can carry an off-centre one. */
    centroid: Vec3;
}

/**
 * Volume and centroid of a closed convex polyhedron, by tetrahedron decomposition about the shape
 * origin: each face is fanned into triangles and each triangle forms a tetrahedron with the origin.
 * The signed sum is exact, and stays correct even when the origin lies outside the hull, provided the
 * faces are consistently wound — which cannon requires anyway.
 */
function convexMass(hull: ConvexPolyhedron): ShapeMass {
    const v = hull.vertices;
    let volume = 0;
    let cx = 0, cy = 0, cz = 0;

    for (const face of hull.faces) {
        for (let i = 1; i + 1 < face.length; i++) {
            const a = v[face[0]], b = v[face[i]], c = v[face[i + 1]];
            // dot(a, cross(b, c)) — six times the signed tetrahedron volume, expanded to stay
            // allocation-free.
            const sixV =
                a.x * (b.y * c.z - b.z * c.y) +
                a.y * (b.z * c.x - b.x * c.z) +
                a.z * (b.x * c.y - b.y * c.x);
            volume += sixV;
            // A tetrahedron's centroid is the mean of its four corners, one of which is the origin —
            // hence the sum of three and the 1/4 folded into `scale` below.
            cx += sixV * (a.x + b.x + c.x);
            cy += sixV * (a.y + b.y + c.y);
            cz += sixV * (a.z + b.z + c.z);
        }
    }

    // A degenerate or inside-out hull must not produce NaN: report no volume and let the caller skip it.
    if (!isFinite(volume) || Math.abs(volume) < 1e-12) return { volume: 0, centroid: new Vec3() };
    const scale = 1 / (4 * volume);
    return { volume: Math.abs(volume) / 6, centroid: new Vec3(cx * scale, cy * scale, cz * scale) };
}

/**
 * Volume and centroid of one cannon shape.
 *
 * Dispatches on the numeric `shape.type`, NEVER on `constructor.name`: `dist` is minified and the class
 * names are mangled there. `Cylinder` extends `ConvexPolyhedron` without overriding its type, so the
 * convex branch covers it — and covers a capsule's cylinder section for free.
 */
export function shapeMassProperties(shape: Shape): ShapeMass {
    switch (shape.type) {
        case Shape.types.SPHERE: {
            const r = (shape as Sphere).radius;
            return { volume: (4 / 3) * Math.PI * r * r * r, centroid: new Vec3() };
        }
        case Shape.types.BOX: {
            const h = (shape as Box).halfExtents;
            return { volume: 8 * h.x * h.y * h.z, centroid: new Vec3() };
        }
        case Shape.types.CONVEXPOLYHEDRON:
            return convexMass(shape as ConvexPolyhedron);
        // Plane, Heightfield, Trimesh and Particle bound no volume. They only ever appear on static
        // bodies here, and recenterMass skips those outright.
        default:
            return { volume: 0, centroid: new Vec3() };
    }
}

/**
 * Volume-weighted centre of mass of a compound body, in body-local space — i.e. uniform density across
 * every shape, which is the only assumption available: cannon carries no per-shape density.
 *
 * The three arrays are cannon's own `body.shapes` / `shapeOffsets` / `shapeOrientations`, parallel by
 * construction. Returns a zero vector when nothing bounds a volume, so a plane-only body is untouched.
 */
export function bodyCenterOfMass(
    shapes: Shape[], offsets: Vec3[], orientations: Quaternion[], out: Vec3 = new Vec3()
): Vec3 {
    out.set(0, 0, 0);
    let total = 0;
    const local = new Vec3();

    for (let i = 0; i < shapes.length; i++) {
        const { volume, centroid } = shapeMassProperties(shapes[i]);
        if (volume <= 0) continue;

        // The shape's own rotation DOES move its centroid — unlike the offset, which cannon applies
        // verbatim, independent of that rotation (see CBody.attachShape).
        orientations[i].vmult(centroid, local);
        local.vadd(offsets[i], local);

        out.x += local.x * volume;
        out.y += local.y * volume;
        out.z += local.z * volume;
        total += volume;
    }

    if (total > 0) out.scale(1 / total, out);
    return out;
}
