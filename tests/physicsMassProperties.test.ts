import { describe, it, expect } from 'vitest';
import { World, Body, Plane, Box as CannonBox, Sphere as CannonSphere, ConvexPolyhedron, Vec3, Quaternion } from 'cannon-es';
import { shapeMassProperties, bodyCenterOfMass } from '../src/physics/massProperties';
import { RigidBody } from '../src/physics/body';
import { Shape } from '../src/physics/shape';
import { Node } from '../src/core/scene/nodes/node';

/**
 * cannon-es has no centre of mass: `body.position` IS it, and `shapeOffsets` move only the collision
 * geometry. An offset collider therefore left the mass at the node origin with the geometry hanging off
 * it, and the ground's normal force — acting at the collider, with the offset as its lever arm — rotated
 * the body until the origin->collider vector lined up with the contact normal. Every object "stood up"
 * and tilted to match the terrain. `CBody.recenterMass` moves the mass into the collider.
 */

/** Angle in DEGREES between an orientation and identity — how far a body turned from where it started. */
const tiltDegrees = (q: Quaternion): number => 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI;

// Corner order below is (x, y, z) with z fastest, so:
// 0=---  1=--+  2=-+-  3=-++  4=+--  5=+-+  6=++-  7=+++
// Every loop is wound CCW seen from OUTSIDE, which both cannon and the tetrahedron decomposition
// require — cannon logs a "points into the shape?" warning per face when it is not.
const CUBE_FACES = [
    [0, 1, 3, 2], // -X
    [4, 6, 7, 5], // +X
    [0, 4, 5, 1], // -Y
    [2, 3, 7, 6], // +Y
    [0, 2, 6, 4], // -Z
    [1, 5, 7, 3], // +Z
];

const cubeCorners = (centre: [number, number, number]): number[][] => {
    const out: number[][] = [];
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5])
        out.push([x + centre[0], y + centre[1], z + centre[2]]);
    return out;
};

/** A unit cube as an explicit ConvexPolyhedron, translated so its centroid sits at `centre`. */
const cubeHull = (centre: [number, number, number]): ConvexPolyhedron => new ConvexPolyhedron({
    vertices: cubeCorners(centre).map(v => new Vec3(v[0], v[1], v[2])),
    faces: CUBE_FACES.map(f => [...f]),
});

/** 90 degrees about Z — a body handed this starts lying on its side. */
const ON_ITS_SIDE = (() => { const q = new Quaternion(); q.setFromEuler(0, 0, Math.PI / 2); return q; })();

/** A world with a level static ground plane at y = 0. */
const groundedWorld = (): World => {
    const world = new World();
    world.gravity.set(0, -9.82, 0);
    const ground = new Body({ mass: 0 });
    ground.addShape(new Plane());
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0); // plane faces +Y
    world.addBody(ground);
    return world;
};

const drop = (world: World, body: Body, seconds = 4): void => {
    world.addBody(body);
    for (let i = 0; i < Math.round(seconds * 60); i++) world.step(1 / 60);
};

describe('shape mass properties', () => {
    it('matches the analytic volume of the primitives', () => {
        expect(shapeMassProperties(new CannonSphere(2)).volume).toBeCloseTo((4 / 3) * Math.PI * 8, 6);
        expect(shapeMassProperties(new CannonBox(new Vec3(1, 2, 3))).volume).toBeCloseTo(48, 6);
        // Nothing that bounds no volume may contribute, or it would drag the centre of mass towards it.
        expect(shapeMassProperties(new Plane()).volume).toBe(0);
    });

    it('finds a convex hull volume and its true centroid, wherever the hull sits', () => {
        const centred = shapeMassProperties(cubeHull([0, 0, 0]));
        expect(centred.volume).toBeCloseTo(1, 6);
        expect(centred.centroid.x).toBeCloseTo(0, 9);
        expect(centred.centroid.y).toBeCloseTo(0, 9);
        expect(centred.centroid.z).toBeCloseTo(0, 9);

        // The origin is OUTSIDE this hull; the signed decomposition must still be exact. cannon logs a
        // "points into the shape?" warning for it — that heuristic tests each face plane against the
        // ORIGIN and assumes the hull surrounds it, so it is a false positive here, not bad winding.
        const offset = shapeMassProperties(cubeHull([0, 2, 0]));
        expect(offset.volume).toBeCloseTo(1, 6);
        expect(offset.centroid.y).toBeCloseTo(2, 6);
    });

    it('weights a compound by volume, and rotates each centroid by its own shape orientation', () => {
        const shapes = [new CannonBox(new Vec3(0.5, 0.5, 0.5)), new CannonBox(new Vec3(0.5, 0.5, 0.5))];
        const offsets = [new Vec3(0, 0, 0), new Vec3(0, 4, 0)];
        const orientations = [new Quaternion(), new Quaternion()];
        // Equal volumes, so the centre lands exactly between them.
        expect(bodyCenterOfMass(shapes, offsets, orientations).y).toBeCloseTo(2, 6);

        // A shape rotation moves its centroid — unlike its offset, which cannon applies verbatim.
        const rotated = new Quaternion();
        rotated.setFromEuler(0, 0, Math.PI / 2); // +Y -> -X
        const com = bodyCenterOfMass([cubeHull([0, 2, 0])], [new Vec3()], [rotated]);
        expect(com.x).toBeCloseTo(-2, 5);
        expect(com.y).toBeCloseTo(0, 5);
    });
});

describe('RigidBody.recenterMass', () => {
    it('re-bases the shapes onto the centre of mass without moving the node', () => {
        const body = new RigidBody({ mass: 1, position: [0, 5, 0] });
        body.attachShape(Shape.Box(1, 1, 1), [0, 2, 0]);
        body.recenterMass();

        // The collider is now centred on the body origin...
        expect(body.shapeOffsets[0].y).toBeCloseTo(0, 6);
        // ...the body sits where the collider was...
        expect(body.position.y).toBeCloseTo(7, 6);
        // ...and the NODE is still exactly where it was put. That last one is what makes the fix invisible.
        expect(body.originPosition([0, 0, 0])[1]).toBeCloseTo(5, 6);
    });

    it('keeps the node origin fixed when the body is rotated', () => {
        const body = new RigidBody({ mass: 1, position: [0, 5, 0] });
        body.attachShape(Shape.Box(1, 1, 1), [0, 2, 0]);
        body.recenterMass();

        body.setQuaternion([0, 0, 1, 0]); // 180 degrees about Z: the collider swings below the origin
        expect(body.position.y).toBeCloseTo(3, 5);
        expect(body.originPosition([0, 0, 0])[1]).toBeCloseTo(5, 5);
    });

    it('leaves a body whose collider is already centred alone', () => {
        const body = new RigidBody({ mass: 1, position: [1, 2, 3] });
        body.attachShape(Shape.Box(1, 1, 1), [0, 0, 0]);
        body.recenterMass();

        expect(body.shapeOffsets[0].almostEquals(new Vec3(0, 0, 0), 1e-9)).toBe(true);
        expect(body.originPosition([0, 0, 0])[0]).toBeCloseTo(1, 9);
        expect(body.originPosition([0, 0, 0])[1]).toBeCloseTo(2, 9);
        expect(body.originPosition([0, 0, 0])[2]).toBeCloseTo(3, 9);
    });

    it('skips static bodies, whose pose is authored rather than simulated', () => {
        const body = new RigidBody({ mass: 0, position: [0, 5, 0] });
        body.attachShape(Shape.Box(1, 1, 1), [0, 2, 0]);
        body.recenterMass();

        expect(body.shapeOffsets[0].y).toBeCloseTo(2, 6);
        expect(body.position.y).toBeCloseTo(5, 6);
    });

    it('measures inertia in the body frame, not in whatever pose the author left', () => {
        const level = new RigidBody({ mass: 1, quaternion: [0, 0, 0, 1] });
        level.attachShape(Shape.Box(3, 1, 1));
        level.recenterMass();

        const turned = new RigidBody({ mass: 1, quaternion: [0, 0.3826834, 0, 0.9238795] }); // 45 deg / Y
        turned.attachShape(Shape.Box(3, 1, 1));
        turned.recenterMass();

        // cannon derives inertia from the WORLD aabb, and Node.setBody builds the body already rotated,
        // so without the fix the turned body bakes a fatter, skewed tensor into its own frame.
        expect(turned.inertia.x).toBeCloseTo(level.inertia.x, 6);
        expect(turned.inertia.y).toBeCloseTo(level.inertia.y, 6);
        expect(turned.inertia.z).toBeCloseTo(level.inertia.z, 6);
    });
});

describe('an offset collider settles under gravity', () => {
    /**
     * The reported bug, reproduced. Without recenterMass the body has to rotate to put its origin over
     * the contact point, which is what the user saw as "it lines up with the terrain normal". Each case
     * asserts the unfixed control too, so none of these can pass vacuously.
     */
    it('lets a tall object stay lying down instead of standing itself up', () => {
        // The user's report, verbatim: "every object always ends up upwards". With the mass at the node
        // origin and the collider above it, the body is a HANGING pendulum — the stable rest pose is the
        // one with the offset straight up, so a bar dropped on its side rights itself every time.
        const lyingDown = [0, 0, ON_ITS_SIDE.z, ON_ITS_SIDE.w] as [number, number, number, number];

        const control = new RigidBody({ mass: 1, position: [0, 4, 0], quaternion: lyingDown });
        control.attachShape(Shape.Box(1, 3, 1), [0, 2, 0]);
        drop(groundedWorld(), control, 8);
        expect(tiltDegrees(control.quaternion)).toBeLessThan(10); // stood bolt upright — the bug

        const fixed = new RigidBody({ mass: 1, position: [0, 4, 0], quaternion: lyingDown });
        fixed.attachShape(Shape.Box(1, 3, 1), [0, 2, 0]);
        fixed.recenterMass();
        drop(groundedWorld(), fixed, 8);
        expect(tiltDegrees(fixed.quaternion)).toBeGreaterThan(80); // stayed on its side, as it should
    });

    it('does not tip over when its box collider sits to one side of the node origin', () => {
        const control = new RigidBody({ mass: 1, position: [0, 3, 0] });
        control.attachShape(Shape.Box(1, 1, 1), [2, 0, 0]);
        drop(groundedWorld(), control);
        expect(tiltDegrees(control.quaternion)).toBeGreaterThan(45);

        const fixed = new RigidBody({ mass: 1, position: [0, 3, 0] });
        fixed.attachShape(Shape.Box(1, 1, 1), [2, 0, 0]);
        fixed.recenterMass();
        drop(groundedWorld(), fixed);
        expect(tiltDegrees(fixed.quaternion)).toBeLessThan(5);
    });

    it('does the same for a convex hull, which is how the editor fits irregular meshes', () => {
        // Exactly what the hull authoring path produces: centroid-local vertices, plus that centroid as
        // the shape offset (PhysicsEditor buildHull writes `offset: hull.center`).
        const vertices = cubeCorners([0, 0, 0]);

        const fixed = new RigidBody({ mass: 1, position: [0, 3, 0] });
        fixed.attachShape(Shape.ConvexHull(vertices, CUBE_FACES)!, [0, 1.5, 0]);
        fixed.recenterMass();
        drop(groundedWorld(), fixed);

        expect(tiltDegrees(fixed.quaternion)).toBeLessThan(5);
        // And it came to rest ON the hull: the node origin ends 1.5 below the collider centre, which is
        // itself half a unit above the ground.
        expect(fixed.originPosition([0, 0, 0])[1]).toBeCloseTo(-1, 1);
    });
});

describe('the parse path wires it up', () => {
    /**
     * The whole fix is worthless if `Node` forgets to call it, and nothing else would catch that: the
     * collider still looks right in the viewport, and only the way the object falls gives it away.
     */
    it('recentres a body parsed from scene JSON, leaving the node where it was authored', () => {
        const root = new Node('root');
        Node.parse(root, {
            name: 'crate',
            nodeType: 'node',
            id: 'crate',
            position: [0, 5, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            body: {
                mass: 2,
                // What the editor writes for any model whose origin is not at its bounds centre.
                shapes: [{ type: 'box', width: 1, height: 1, depth: 1, offset: [0, 2, 0], rotation: [0, 0, 0] }],
            },
        } as any);

        const node = root.getChildByName('crate')[0];
        expect(node.body).not.toBeNull();
        expect(node.body!.shapeOffsets[0].y).toBeCloseTo(0, 6);
        expect(node.body!.position.y).toBeCloseTo(7, 6);
        // The authored transform is untouched — the compensation must never move anything on screen.
        expect(node.position[1]).toBeCloseTo(5, 6);
        expect(node.body!.originPosition([0, 0, 0])[1]).toBeCloseTo(5, 6);
    });

    it('does not recentre a trigger, which PhysicsSystem drives from the node transform directly', () => {
        const root = new Node('root');
        Node.parse(root, {
            name: 'zone',
            nodeType: 'node',
            id: 'zone',
            position: [0, 5, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            trigger: {
                shapes: [{ type: 'box', width: 1, height: 1, depth: 1, offset: [0, 2, 0], rotation: [0, 0, 0] }],
            },
        } as any);

        const node = root.getChildByName('zone')[0];
        expect(node.trigger!.shapeOffsets[0].y).toBeCloseTo(2, 6);
        expect(node.trigger!.position.y).toBeCloseTo(5, 6);
    });
});
