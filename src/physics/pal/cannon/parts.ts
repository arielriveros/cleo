import { Shape } from 'cannon-es';
import type { Body, Box, ConvexPolyhedron, Cylinder, Sphere } from 'cannon-es';
import type { ColliderPart, ConvexHull, PartShape } from '../types';

// A cannon body's shapes as the layer's ColliderParts (../types.ts), placed in the body's own frame — which
// for cannon is its centre of mass, since `body.position` is that. The numbers are cannon's own, copied,
// never recomputed: whatever measures a body from these (overlap queries, buoyancy) must get exactly the
// values it got from the cannon shapes, or the simulation's bits move.

interface Cached {
    shapes: Shape[];
    /** Each part's offset and orientation as built: [ox oy oz qx qy qz qw] per shape. */
    pose: number[];
    parts: ColliderPart[];
}

const cache = new WeakMap<Body, Cached>();
const hulls = new WeakMap<ConvexPolyhedron, ConvexHull>();

function hullOf(shape: ConvexPolyhedron): ConvexHull {
    let hull = hulls.get(shape);
    if (!hull) {
        if (!shape.faceNormals?.length) shape.computeNormals();
        hull = {
            vertices: shape.vertices.map(v => [v.x, v.y, v.z] as const),
            faces: shape.faces.map(f => [...f]),
            normals: shape.faceNormals.map(n => [n.x, n.y, n.z] as const),
        };
        hulls.set(shape, hull);
    }
    return hull;
}

function partShape(shape: Shape): PartShape {
    switch (shape.type) {
        case Shape.types.SPHERE: return { kind: 'sphere', radius: (shape as Sphere).radius };
        case Shape.types.BOX: {
            const h = (shape as Box).halfExtents;
            return { kind: 'box', halfExtents: [h.x, h.y, h.z] };
        }
        case Shape.types.CYLINDER: {
            const c = shape as Cylinder & { radiusTop: number; radiusBottom: number; height: number; numSegments: number };
            return { kind: 'cylinder', radiusTop: c.radiusTop, radiusBottom: c.radiusBottom, height: c.height, segments: c.numSegments, hull: hullOf(c) };
        }
        case Shape.types.CONVEXPOLYHEDRON: return { kind: 'convex', hull: hullOf(shape as ConvexPolyhedron) };
        // cannon's plane faces its local +Z.
        case Shape.types.PLANE: return { kind: 'plane', normal: [0, 0, 1] };
        case Shape.types.HEIGHTFIELD: return { kind: 'heightfield' };
        case Shape.types.TRIMESH: return { kind: 'trimesh' };
        // A particle: a point.
        default: return { kind: 'sphere', radius: 0 };
    }
}

/** Whether the cached parts still describe the body's shapes, where they are. */
function current(body: Body, c: Cached): boolean {
    const n = body.shapes.length;
    if (c.shapes.length !== n) return false;
    for (let i = 0; i < n; i++) {
        if (c.shapes[i] !== body.shapes[i]) return false;
        const o = body.shapeOffsets[i], q = body.shapeOrientations[i], k = i * 7, p = c.pose;
        if (p[k] !== o.x || p[k + 1] !== o.y || p[k + 2] !== o.z || p[k + 3] !== q.x || p[k + 4] !== q.y || p[k + 5] !== q.z || p[k + 6] !== q.w) return false;
    }
    return true;
}

/** The body's shapes as parts, in shape order. Cached until a shape, offset or orientation changes. */
export function cannonColliderParts(body: Body): readonly ColliderPart[] {
    const cached = cache.get(body);
    if (cached && current(body, cached)) return cached.parts;
    const pose: number[] = [];
    const parts: ColliderPart[] = body.shapes.map((shape, i) => {
        const o = body.shapeOffsets[i], q = body.shapeOrientations[i];
        pose.push(o.x, o.y, o.z, q.x, q.y, q.z, q.w);
        return { shape: partShape(shape), offset: [o.x, o.y, o.z], rotation: [q.x, q.y, q.z, q.w], boundingRadius: shape.boundingSphereRadius };
    });
    cache.set(body, { shapes: [...body.shapes], pose, parts });
    return parts;
}
