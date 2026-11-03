import { PhysicsBody, type PhysicsBodyOptions } from '../../src/physics/physicsBody';
import type { ColliderDesc, ShapeDesc } from '../../src/physics/pal/types';

// Engine physics bodies for tests, in a line: the shapes as the physics layer describes them (see
// src/physics/pal/types.ts), and a body made of them.

export const box = (hx: number, hy: number, hz: number): ShapeDesc => ({ kind: 'box', halfExtents: [hx, hy, hz] });
export const sphere = (radius: number): ShapeDesc => ({ kind: 'sphere', radius });
export const cylinder = (radius: number, height: number, segments = 12): ShapeDesc =>
    ({ kind: 'cylinder', radiusTop: radius, radiusBottom: radius, height, segments });
/** A heightfield laid the layer's way: from its corner, i along +X, j along -Z, heights up. */
export const heightfield = (heights: number[][], elementSize: number): ShapeDesc => ({ kind: 'heightfield', heights, elementSize });
/** A plane through the body's origin, facing +Y. */
export const plane = (): ShapeDesc => ({ kind: 'plane' });

/** The engine's capsule as Node.parse attaches it: a cylinder, and a sphere on each end. `height` is tip to tip. */
export function engineCapsule(radius: number, height: number, segments = 12): ColliderDesc[] {
    const cyl = height - 2 * radius;
    return [
        { shape: cylinder(radius, cyl, segments) },
        { shape: sphere(radius), offset: [0, cyl / 2, 0] },
        { shape: sphere(radius), offset: [0, -cyl / 2, 0] },
    ];
}

/** A body of one shape (at its origin) or of colliders. Static unless given a mass. */
export function makeBody(colliders: ShapeDesc | ColliderDesc[], options: PhysicsBodyOptions = {}): PhysicsBody {
    const body = new PhysicsBody(options);
    for (const c of Array.isArray(colliders) ? colliders : [{ shape: colliders }]) body.addCollider(c);
    return body;
}
