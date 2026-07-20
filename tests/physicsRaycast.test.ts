import { describe, it, expect } from 'vitest';
import { World, Body, Box, Vec3, Heightfield, RaycastResult } from 'cannon-es';
import { skipCameraHit } from '../src/physics/cameraRayFilter';

// Mirrors PhysicsSystem.raycastCamera: every hit along the segment, filtered, nearest survivor wins.
// PhysicsSystem itself imports the cleo barrel and cannot be loaded here, so the filter rule lives in
// its own leaf module (cameraRayFilter) and this drives it against a real cannon World.
function raycastCamera(world: World, from: Vec3, to: Vec3, reject?: (owner: any) => boolean): number | null {
    let nearest: number | null = null;
    world.raycastAll(from, to, { checkCollisionResponse: false }, (result) => {
        if (skipCameraHit(result.body as any, reject)) return;
        if (result.hasHit && (nearest === null || result.distance < nearest)) nearest = result.distance;
    });
    return nearest;
}

const wallAt = (z: number, extra: Record<string, any> = {}) => {
    const body = new Body({ mass: 0 });
    body.addShape(new Box(new Vec3(3, 3, 0.1)));
    body.position.set(0, 0, z);
    Object.assign(body, extra);
    return body;
};

const ORIGIN = new Vec3(0, 0, 0);
const BACK = new Vec3(0, 0, -10);

describe('camera probe filtering', () => {
    /**
     * The regression this whole design exists for. cannon consults `isTrigger` only in its solver, so
     * `raycastClosest` returns the trigger as the nearest obstruction and the camera slams in. If
     * someone "simplifies" raycastCamera back to raycastClosest, this is what catches it.
     */
    it('sees past a trigger volume to the wall behind it', () => {
        const world = new World();
        const wall = wallAt(-4);
        const trigger = wallAt(-2, { isTrigger: true });
        world.addBody(wall);
        world.addBody(trigger);

        // Baseline: prove cannon really does report the trigger, so this test cannot pass vacuously.
        const closest = new RaycastResult();
        world.raycastClosest(ORIGIN, BACK, { checkCollisionResponse: true }, closest);
        expect(closest.body).toBe(trigger);

        expect(raycastCamera(world, ORIGIN, BACK)).toBeCloseTo(3.9, 5);
    });

    it('skips bodies with the camera channel off, and keeps them when it is on', () => {
        const world = new World();
        world.addBody(wallAt(-4, { cameraCollision: false }));
        expect(raycastCamera(world, ORIGIN, BACK)).toBeNull();

        const world2 = new World();
        world2.addBody(wallAt(-4, { cameraCollision: true }));
        expect(raycastCamera(world2, ORIGIN, BACK)).toBeCloseTo(3.9, 5);
    });

    // The two channels are independent: a body can be a ghost to the solver and still stop the camera.
    // This is why the probe passes checkCollisionResponse: false.
    it('still hits a body that does not simulate physically', () => {
        const world = new World();
        world.addBody(wallAt(-4, { collisionResponse: false }));
        expect(raycastCamera(world, ORIGIN, BACK)).toBeCloseTo(3.9, 5);
    });

    it('honours the caller ignore rule by owning node', () => {
        const world = new World();
        const player = { name: 'player' };
        world.addBody(wallAt(-2, { owner: player }));
        world.addBody(wallAt(-6));
        // Nearest is the player's own body; rejecting it must fall through to the wall behind.
        expect(raycastCamera(world, ORIGIN, BACK, (o) => o === player)).toBeCloseTo(5.9, 5);
    });

    it('returns null rather than -1 when nothing is hit', () => {
        expect(raycastCamera(new World(), ORIGIN, BACK)).toBeNull();
    });

    /**
     * Guards having deleted the rig's separate analytic terrain march: terrain registers a Heightfield
     * in the same world (mass 0, rotated -90deg about X to take the field's Z-up into the world's
     * Y-up), so one query must cover it.
     */
    it('hits a Heightfield registered the way Terrain does', () => {
        const world = new World();
        const data = Array.from({ length: 10 }, () => new Array(10).fill(0));
        const body = new Body({ mass: 0 });
        body.addShape(new Heightfield(data, { elementSize: 1 }));
        body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
        body.position.set(-5, 0, 5);
        world.addBody(body);

        const hit = raycastCamera(world, new Vec3(0, 1, 0), new Vec3(0, -5, 0));
        expect(hit).not.toBeNull();
        expect(hit!).toBeCloseTo(1, 3);
    });
});

describe('skipCameraHit', () => {
    it('rejects a missing body', () => {
        expect(skipCameraHit(null)).toBe(true);
        expect(skipCameraHit(undefined)).toBe(true);
    });

    // Bodies the engine did not create (the terrain heightfield) have no cameraCollision field at all.
    it('treats an absent camera channel as solid', () => {
        expect(skipCameraHit({})).toBe(false);
    });

    it('keeps ownerless bodies when a reject rule is supplied', () => {
        const reject = (owner: any) => owner !== null && owner.name === 'player';
        expect(skipCameraHit({}, reject)).toBe(false);
    });
});
