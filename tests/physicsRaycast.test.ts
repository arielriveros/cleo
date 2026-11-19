import { describe, it, expect } from 'vitest';
import { World, Body, Box, Vec3, Heightfield, RaycastResult } from 'cannon-es';
import { skipCameraHit, skipRayHit, type CameraProbeLayers } from '../src/physics/cameraRayFilter';
import { ALL_LAYERS, DEFAULT_CAMERA_BLOCKED_BY, DEFAULT_CAMERA_SEE_THROUGH, LAYER } from '../src/physics/collisionLayers';

/** A rig's layers as it starts: blocked by everything but See Through and No Camera, seeing through See Through. */
const RIG: CameraProbeLayers = { blockedBy: DEFAULT_CAMERA_BLOCKED_BY, seeThrough: DEFAULT_CAMERA_SEE_THROUGH };

// Mirrors PhysicsSystem.raycastCamera: every hit along the segment, filtered, nearest survivor wins.
// PhysicsSystem itself imports the cleo barrel and cannot be loaded here, so the filter rule lives in
// its own leaf module (cameraRayFilter) and this drives it against a real cannon World.
function raycastCamera(world: World, from: Vec3, to: Vec3, reject?: (owner: any) => boolean, layers: CameraProbeLayers = RIG): number | null {
    let nearest: number | null = null;
    world.raycastAll(from, to, { checkCollisionResponse: false }, (result) => {
        if (skipCameraHit(result.body as any, layers, reject)) return;
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

    it('stops only at the layers the rig is blocked by', () => {
        const world = new World();
        world.addBody(wallAt(-4, { collisionFilterGroup: LAYER.NO_CAMERA }));
        expect(raycastCamera(world, ORIGIN, BACK)).toBeNull();
        // A rig blocked by every layer stops at it after all.
        expect(raycastCamera(world, ORIGIN, BACK, undefined, { blockedBy: ALL_LAYERS, seeThrough: 0 })).toBeCloseTo(3.9, 5);

        const world2 = new World();
        world2.addBody(wallAt(-4, { collisionFilterGroup: LAYER.DEFAULT }));
        expect(raycastCamera(world2, ORIGIN, BACK)).toBeCloseTo(3.9, 5);
    });

    it('passes what it sees through to the wall behind it', () => {
        const world = new World();
        world.addBody(wallAt(-2, { collisionFilterGroup: LAYER.SEE_THROUGH }));
        world.addBody(wallAt(-6));
        expect(raycastCamera(world, ORIGIN, BACK)).toBeCloseTo(5.9, 5);
        // A rig that sees through nothing and is blocked by everything stops at the first.
        expect(raycastCamera(world, ORIGIN, BACK, undefined, { blockedBy: ALL_LAYERS, seeThrough: 0 })).toBeCloseTo(1.9, 5);
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

    // Bodies the engine did not create (the terrain heightfield) have no layer of their own: Default.
    it('treats a body with no layer as on the Default layer', () => {
        expect(skipCameraHit({}, RIG)).toBe(false);
        expect(skipCameraHit({}, { blockedBy: ALL_LAYERS & ~LAYER.DEFAULT, seeThrough: 0 })).toBe(true);
        expect(skipCameraHit({}, { blockedBy: ALL_LAYERS, seeThrough: LAYER.DEFAULT })).toBe(true);
    });

    it('rejects triggers whatever their layer', () => {
        expect(skipCameraHit({ isTrigger: true, collisionFilterGroup: LAYER.DEFAULT }, { blockedBy: ALL_LAYERS, seeThrough: 0 })).toBe(true);
    });

    it('keeps ownerless bodies when a reject rule is supplied', () => {
        const reject = (owner: any) => owner !== null && owner.name === 'player';
        expect(skipCameraHit({}, RIG, reject)).toBe(false);
    });

    it('passes a See through layer even when the rig is blocked by it too', () => {
        const pillar = { collisionFilterGroup: LAYER.SEE_THROUGH };
        const wall = { collisionFilterGroup: LAYER.DEFAULT };
        const crate = { collisionFilterGroup: LAYER.NO_CAMERA };
        const both: CameraProbeLayers = { blockedBy: ALL_LAYERS, seeThrough: LAYER.SEE_THROUGH };
        expect(skipCameraHit(pillar, both)).toBe(true);
        expect(skipCameraHit(wall, both)).toBe(false);
        expect(skipCameraHit(crate, both)).toBe(false);
        // The default rig: the pillar is seen through, the crate ignored, the wall pulls in.
        expect(skipCameraHit(pillar, RIG)).toBe(true);
        expect(skipCameraHit(crate, RIG)).toBe(true);
        expect(skipCameraHit(wall, RIG)).toBe(false);
        // A rig that sees through nothing pulls in for the pillar.
        expect(skipCameraHit(pillar, { blockedBy: ALL_LAYERS, seeThrough: 0 })).toBe(false);
    });
});

// The general filter behind PhysicsSystem.raycast. Its defaults are what "solid" ordinarily means, which is
// the OPPOSITE of what the camera probe wants on two counts — so the two rules cannot be merged, and the
// defaults have to be pinned or a foot ends up standing on a trigger volume.
describe('skipRayHit', () => {
    it('rejects a missing body', () => {
        expect(skipRayHit(null)).toBe(true);
        expect(skipRayHit(undefined)).toBe(true);
    });

    it('accepts a plain solid body with no options', () => {
        expect(skipRayHit({})).toBe(false);
    });

    it('rejects triggers and ghosts by default, and keeps them when asked', () => {
        expect(skipRayHit({ isTrigger: true })).toBe(true);
        expect(skipRayHit({ isTrigger: true }, { includeTriggers: true })).toBe(false);
        expect(skipRayHit({ collisionResponse: false })).toBe(true);
        expect(skipRayHit({ collisionResponse: false }, { includeGhosts: true })).toBe(false);
        // Absent means solid: bodies the engine did not create carry neither field.
        expect(skipRayHit({ collisionResponse: undefined })).toBe(false);
    });

    it('skips the caster itself, given singly or as a list', () => {
        const self = {};
        const other = {};
        expect(skipRayHit(self, { ignore: self })).toBe(true);
        expect(skipRayHit(other, { ignore: self })).toBe(false);
        expect(skipRayHit(other, { ignore: [self, other] })).toBe(true);
        expect(skipRayHit(other, { ignore: null })).toBe(false);
    });

    it('keeps only the layers a layer mask names', () => {
        const stairSteps = { collisionFilterGroup: 32 };
        expect(skipRayHit(stairSteps, { layerMask: ALL_LAYERS })).toBe(false);
        expect(skipRayHit(stairSteps, { layerMask: 32 | LAYER.DEFAULT })).toBe(false);
        expect(skipRayHit(stairSteps, { layerMask: LAYER.DEFAULT })).toBe(true);
        // No layer of its own: Default.
        expect(skipRayHit({}, { layerMask: LAYER.DEFAULT })).toBe(false);
        expect(skipRayHit({}, { layerMask: 32 })).toBe(true);
    });

    it('keeps only what a body collides with, both ways round', () => {
        // A capsule on layer 16 that leaves the steps (32) out of its mask, and a ramp (64) only it collides with.
        const capsule = { collisionFilterGroup: 16, collisionFilterMask: ALL_LAYERS & ~32 };
        const steps = { collisionFilterGroup: 32, collisionFilterMask: ALL_LAYERS };
        const ramp = { collisionFilterGroup: 64, collisionFilterMask: 16 };
        const prop = { collisionFilterGroup: LAYER.DEFAULT, collisionFilterMask: ALL_LAYERS };
        expect(skipRayHit(steps, { collidingWith: capsule })).toBe(true);
        expect(skipRayHit(ramp, { collidingWith: capsule })).toBe(false);
        expect(skipRayHit({}, { collidingWith: capsule })).toBe(false);
        // The prop collides with the steps, and not with the ramp, whose mask leaves it out.
        expect(skipRayHit(steps, { collidingWith: prop })).toBe(false);
        expect(skipRayHit(ramp, { collidingWith: prop })).toBe(true);
    });

    it('gives the caller rule the last word, with the owning node', () => {
        const owned = { owner: { name: 'crate' } as any };
        expect(skipRayHit(owned, { reject: (o) => (o as any)?.name === 'crate' })).toBe(true);
        expect(skipRayHit(owned, { reject: (o) => (o as any)?.name === 'wall' })).toBe(false);
        // An ownerless body — the terrain heightfield — reaches the rule as null rather than being dropped.
        let sawOwner: unknown = 'unset';
        skipRayHit({}, { reject: (o) => { sawOwner = o; return false; } });
        expect(sawOwner).toBeNull();
    });
});
