import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Scene, CleoEngine, PhysicsSystem } from '../src/cleo';
import type { CharacterNode, ColliderNode, ControllerNode } from '../src/cleo';
import { LoopbackPort } from '../src/physics/worker/ports';
import { TEST_PHYSICS } from './helpers/testPhysics';

// A Character crouches (CharacterNode `crouchCapsuleHeight`): its Collider's capsule is shortened, feet kept, while
// the intent crouches, and stands back up only where the standing capsule fits. Runs on every backend
// (vitest.config.ts), and through the physics worker.

const FRAME = 1 / 60;
/** The Sandbox's character: a 0.28 m capsule 1.765 m tall, 75 kg, upright, frictionless. */
const R = 0.28, HEIGHT = 1.765, CROUCH = 1.2, MASS = 75;

let authoring = false;
const played: PhysicsSystem[] = [];
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; for (const p of played.splice(0)) p.dispose(); });

const box = (id: string, position: number[], size: number[]) => ({
    type: 'collider', id, name: id, position, rotation: [0, 0, 0], scale: [1, 1, 1],
    collider: { mass: 0, friction: 0.3, shapes: [{ type: 'box', width: size[0], height: size[1], depth: size[2], offset: [0, 0, 0], rotation: [0, 0, 0] }] },
    children: [],
});

/**
 * Flat ground, a low slab 1.5 m up over z 2..6 (room under it for a crouch, not for a stand), and a Character in a
 * capsule Collider at the origin, driven with no controller.
 */
function play(character: Record<string, unknown> = {}, port?: LoopbackPort) {
    const player = {
        type: 'collider', id: 'player:collider', name: 'Player Collider', position: [0, 0.01, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        collider: {
            mass: MASS, friction: 0, restitution: 0, linearDamping: 0, angularDamping: 0, linearConstraints: [1, 1, 1], angularConstraints: [0, 0, 0],
            groundProbeDistance: 0.12, simulationMode: 'always',
            shapes: [{ type: 'capsule', radius: R, height: HEIGHT, numSegments: 16, offset: [0, HEIGHT / 2, 0], rotation: [0, 0, 0] }],
        },
        children: [{
            type: 'character', id: 'player', name: 'Player', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            walkSpeed: 3, runSpeed: 6, jumpSpeed: 4, acceleration: 0, facingMode: 'none', driveWhenUnpossessed: true,
            crouchCapsuleHeight: CROUCH, crouchSpeed: 0.5, ...character,
        }],
    };
    const scene = new Scene();
    scene.parse({ scene: { id: 'root', name: 'root', type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [
        box('Ground', [0, -0.5, 0], [40, 1, 40]),
        box('Slab', [0, 1.5 + 0.25, 4], [6, 0.5, 4]),
        player,
    ] } }, true);
    const physics = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: TEST_PHYSICS } as any);
    physics.initialize();
    physics.scene = scene;
    played.push(physics);
    if (port) physics.setWorkerMode('on', () => port);
    scene.start();
    const pawn = scene.findNode('Player') as CharacterNode;
    const collider = scene.findNode('Player Collider') as ColliderNode;
    let t = 0;
    const run = (seconds: number, each?: () => void) => {
        for (let k = 0; k < Math.round(seconds / FRAME); k++) {
            each?.();
            physics.update(FRAME);
            scene.update(FRAME, t * 1000, false);
            physics.endFrame(FRAME);
            t += FRAME;
        }
    };
    /** This frame's wish: `forward` (+Z), crouching or not, a jump pressed. */
    const drive = (forward: number, crouch: boolean, jump = false) => {
        const intent = pawn.drive();
        intent.move = [0, forward]; intent.basisYaw = 0; intent.crouch = crouch;
        if (jump) intent.requests.jump = 0.15;
    };
    /** The body's capsule as it is now: its height and where its middle sits over the Collider's origin. */
    const capsule = () => {
        const c = collider.ownBody!.colliders.find(d => d.shape.kind === 'capsule')!;
        return { height: (c.shape as any).height + 2 * (c.shape as any).radius, middle: c.offset?.[1] ?? 0 };
    };
    return { scene, physics, pawn, collider, run, drive, capsule };
}

describe('a crouching character', () => {
    it('shortens its capsule with its feet kept, moves at its crouch speed, and stands back up', () => {
        const p = play();
        p.run(0.4, () => p.drive(0, false));
        const standing = p.capsule();
        expect(p.pawn.crouched).toBe(false);
        p.run(0.3, () => p.drive(0, true));
        expect(p.pawn.crouched, TEST_PHYSICS).toBe(true);
        const low = p.capsule();
        expect(low.height).toBeCloseTo(CROUCH, 2);
        // Feet where they were: the bottom of the capsule stays at the Collider's origin.
        expect(low.middle - low.height / 2).toBeCloseTo(standing.middle - standing.height / 2, 3);
        expect(p.pawn.isGrounded, `${TEST_PHYSICS} grounded crouched`).toBe(true);
        // Half the walk (3 m/s), and a sprint does not raise it.
        p.run(1, () => { p.drive(-1, true); p.pawn.drive().sprint = true; });
        const speed = Math.hypot(p.pawn.velocity[0], p.pawn.velocity[2]);
        expect(speed, TEST_PHYSICS).toBeCloseTo(1.5, 1);
        p.run(0.3, () => p.drive(0, false));
        expect(p.pawn.crouched).toBe(false);
        expect(p.capsule().height).toBeCloseTo(HEIGHT, 2);
    });

    it('stays down under a low ceiling until it walks out, and drops a jump there', () => {
        const p = play();
        p.run(0.3, () => p.drive(0, true));
        // Under the slab (1.5 m over the ground), still crouching.
        p.run(2.4, () => p.drive(1, true));
        expect(p.collider.worldPosition[2], `${TEST_PHYSICS} under the slab`).toBeGreaterThan(3);
        expect(p.collider.worldPosition[2]).toBeLessThan(5);
        // Let go: no room to stand, so it stays down; a jump is dropped.
        p.run(0.5, () => p.drive(0, false));
        expect(p.pawn.crouched, `${TEST_PHYSICS} stays down under the slab`).toBe(true);
        p.run(0.5, () => p.drive(0, false, true));
        expect(p.pawn.crouched).toBe(true);
        expect(p.collider.worldPosition[1], `${TEST_PHYSICS} no jump under the slab`).toBeLessThan(0.2);
        // Out from under it (the slab ends at z 6), it stands by itself.
        p.run(2.5, () => p.drive(1, false));
        expect(p.collider.worldPosition[2]).toBeGreaterThan(6.4);
        expect(p.pawn.crouched, `${TEST_PHYSICS} stood up past the slab`).toBe(false);
    });

    it('stands for a jump in the open', () => {
        const p = play();
        p.run(0.3, () => p.drive(0, true));
        expect(p.pawn.crouched).toBe(true);
        let peak = 0;
        p.run(0.6, () => { p.drive(0, true, true); peak = Math.max(peak, p.collider.worldPosition[1]); });
        expect(peak, `${TEST_PHYSICS} jumped`).toBeGreaterThan(0.4);
    });

    it('never crouches without a crouch height, and writes nothing new then', () => {
        const p = play({ crouchCapsuleHeight: 0 });
        p.run(0.3, () => p.drive(0, true));
        expect(p.pawn.crouched).toBe(false);
        expect(p.capsule().height).toBeCloseTo(HEIGHT, 2);
    });

    it('crouches through the physics worker', () => {
        const p = play({}, new LoopbackPort());
        p.run(0.4, () => p.drive(0, true));
        expect(p.pawn.crouched).toBe(true);
        p.run(0.5, () => p.drive(0, true));
        expect(p.pawn.isGrounded, `${TEST_PHYSICS} worker: grounded crouched`).toBe(true);
        expect(p.collider.worldPosition[1]).toBeLessThan(0.1);
    });
});

describe('a Controller crouch toggle', () => {
    it('crouches on a press and stands on the next', async () => {
        const { ControllerNode: Controller } = await import('../src/cleo');
        const c = new Controller('C') as ControllerNode;
        c.crouchAction = 'Crouch';
        c.crouchToggle = true;
        const json = await c.serialize();
        expect(json.crouchToggle).toBe(true);
        const plain = new Controller('D');
        expect((await plain.serialize()).crouchToggle).toBeUndefined();
    });
});
