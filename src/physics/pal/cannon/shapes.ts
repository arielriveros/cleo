import { Box, ConvexPolyhedron, Cylinder, Heightfield, Plane, Quaternion, Sphere, Trimesh, Vec3 } from 'cannon-es';
import type { Shape } from 'cannon-es';
import type { ShapeDesc } from '../types';

/** One cannon shape and where it sits in its body (before the collider's own placement). */
export interface CannonPart {
    shape: Shape;
    offset: Vec3;
    orientation: Quaternion;
}

/** Turns field (i, j, height) = (X, Y, Z) into the layer's (X, −Z, Y): cannon's Heightfield is Z-up. */
const HEIGHTFIELD_TURN = new Quaternion().setFromEuler(-Math.PI / 2, 0, 0);
/** cannon's Plane faces +Z; the layer's faces +Y. The same turn. */
const PLANE_TURN = HEIGHTFIELD_TURN;

const DEFAULT_SEGMENTS = 8;

/**
 * The cannon shapes for one shape description, in the shape's own frame. Most are one shape; a capsule
 * is three (cannon has none: a cylinder and a sphere at each end), and a heightfield or plane carries the
 * turn from cannon's Z-up into the layer's Y-up.
 */
export function cannonParts(desc: ShapeDesc): CannonPart[] {
    const at = (shape: Shape, offset = new Vec3(), orientation = new Quaternion()): CannonPart => ({ shape, offset, orientation });
    switch (desc.kind) {
        case 'sphere': return [at(new Sphere(desc.radius))];
        case 'box': return [at(new Box(new Vec3(desc.halfExtents[0], desc.halfExtents[1], desc.halfExtents[2])))];
        case 'cylinder':
            return [at(new Cylinder(desc.radiusTop, desc.radiusBottom, desc.height, desc.segments ?? DEFAULT_SEGMENTS))];
        case 'capsule': {
            if (!(desc.height > 0)) return [at(new Sphere(desc.radius))];
            const half = desc.height / 2;
            return [
                at(new Cylinder(desc.radius, desc.radius, desc.height, desc.segments ?? DEFAULT_SEGMENTS)),
                at(new Sphere(desc.radius), new Vec3(0, half, 0)),
                at(new Sphere(desc.radius), new Vec3(0, -half, 0)),
            ];
        }
        case 'convex':
            return [at(new ConvexPolyhedron({
                vertices: desc.vertices.map(v => new Vec3(v[0], v[1], v[2])),
                faces: desc.faces.map(f => [...f]),
            }))];
        case 'trimesh': {
            const mesh = new Trimesh(Array.from(desc.positions), Array.from(desc.indices));
            if (desc.scale) mesh.setScale(new Vec3(desc.scale[0], desc.scale[1], desc.scale[2]));
            return [at(mesh)];
        }
        case 'heightfield':
            // Not copied: a landscape's field is large, and cannon only reads it.
            return [at(new Heightfield(desc.heights as number[][], { elementSize: desc.elementSize }), new Vec3(), HEIGHTFIELD_TURN.clone())];
        case 'plane':
            return [at(new Plane(), new Vec3(), PLANE_TURN.clone())];
    }
}
