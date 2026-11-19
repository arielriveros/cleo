import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Scene, CleoEngine, PhysicsSystem } from '../src/cleo';
import type { CharacterNode, Node } from '../src/cleo';
import { makeBody, box } from './helpers/physicsBodies';
import type { PhysicsBody } from '../src/physics/physicsBody';
import { LoopbackPort } from '../src/physics/worker/ports';
import { TEST_PHYSICS } from './helpers/testPhysics';

// A character stands on a slope without sliding down it (physics/slopeHold.ts, Character `slopeLimit`). The report:
// "the stairs ramp makes the character capsule slide". A character is frictionless, and every substep integrates the
// world's whole gravity into it: the solver takes back the part pressing into the ramp and leaves the part along it,
// so a character standing on a 30 degree ramp crept down it at about 0.1 m/s, braked going down at a - g sin(slope)
// and climbed at a - g sin(slope). Held, gravity only presses it into its ground. Runs on every backend
// (vitest.config.ts).

const FRAME = 1 / 60;
const DEG = Math.PI / 180;
/** The Sandbox's character: a 0.28 m capsule 1.76 m tall, 75 kg, upright, frictionless. */
const R = 0.28, HEIGHT = 1.76, MASS = 75;

let authoring = false;
const played: PhysicsSystem[] = [];
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; for (const p of played.splice(0)) p.dispose(); });

/** Height of a capsule's foot point over the slope it rests on, at the slope's origin line. */
const restHeight = (slope: number) => R * (1 / Math.cos(slope * DEG) - 1) + 0.005;

/**
 * A ramp rising toward +Z at `slope` degrees through the origin (on flat ground beyond it), and a Character in a
 * capsule Collider standing on it at the origin, driven with no controller. The scene plays on a real world.
 */
function play(slope: number, character: Record<string, unknown> = {}, port?: LoopbackPort) {
    const ramp = {
        type: 'collider', id: 'ramp', name: 'Ramp', position: [0, 0, 0], rotation: [-slope, 0, 0], scale: [1, 1, 1],
        collider: { mass: 0, friction: 0.3, shapes: [{ type: 'box', width: 20, height: 1, depth: 60, offset: [0, -0.5, 0], rotation: [0, 0, 0] }] },
        children: [],
    };
    const player = {
        type: 'collider', id: 'player:collider', name: 'Player Collider', position: [0, restHeight(slope), 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        collider: {
            mass: MASS, friction: 0, restitution: 0, linearDamping: 0, angularDamping: 0, linearConstraints: [1, 1, 1], angularConstraints: [0, 0, 0],
            groundProbeDistance: 0.12, simulationMode: 'always',
            shapes: [{ type: 'capsule', radius: R, height: HEIGHT, numSegments: 16, offset: [0, HEIGHT / 2, 0], rotation: [0, 0, 0] }],
        },
        children: [{
            type: 'character', id: 'player', name: 'Player', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            walkSpeed: 3, runSpeed: 5, acceleration: 10, facingMode: 'none', driveWhenUnpossessed: true, ...character,
        }],
    };
    const scene = new Scene();
    scene.parse({ scene: { id: 'root', name: 'root', type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [ramp, player] } }, true);
    const physics = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: TEST_PHYSICS } as any);
    physics.initialize();
    physics.scene = scene;
    played.push(physics);
    if (port) physics.setWorkerMode('on', () => port);
    scene.start();
    const pawn = scene.findNode('Player') as CharacterNode;
    const collider = scene.findNode('Player Collider') as Node;
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
    /** Push the stick: `forward` up the ramp (+Z) or down it (negative), 0 to let go. */
    const move = (forward: number) => { const intent = pawn.drive(); intent.move = [0, forward]; intent.basisYaw = 0; };
    return { scene, physics, pawn, collider, run, move };
}

const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('a character on a slope', () => {
    it('stands still on 25 and 32 degree ramps (the Sandbox stairs\' slabs)', () => {
        for (const slope of [25.5, 32.1]) {
            const p = play(slope);
            p.run(0.5, () => p.move(0));
            const from = Float64Array.from(p.collider.worldPosition);
            p.run(3, () => p.move(0));
            const drift = dist(p.collider.worldPosition, from);
            expect(p.pawn.isGrounded, `${TEST_PHYSICS} ${slope} deg grounded`).toBe(true);
            expect(drift, `${TEST_PHYSICS}: drifted ${(drift * 100).toFixed(2)} cm in 3 s on ${slope} degrees`).toBeLessThan(0.01);
        }
    });

    it('slides as before with the hold off, and on ground steeper than its limit', () => {
        for (const character of [{ slopeLimit: 0 }, { slopeLimit: 20 }]) {
            const p = play(32.1, character);
            p.run(0.5, () => p.move(0));
            const from = Float64Array.from(p.collider.worldPosition);
            p.run(3, () => p.move(0));
            const drift = dist(p.collider.worldPosition, from);
            expect(drift, `${TEST_PHYSICS} slopeLimit ${character.slopeLimit}: crept ${(drift * 100).toFixed(1)} cm`).toBeGreaterThan(0.05);
            // Downhill: toward -Z.
            expect(p.collider.worldPosition[2]).toBeLessThan(from[2]);
        }
    });

    it('brakes as hard going down as going up, as on the flat', () => {
        const a = 10, speed = 3;
        const stopping = (slope: number, direction: 1 | -1) => {
            const p = play(slope, { acceleration: a, walkSpeed: speed });
            // Up and down from the middle of a long ramp.
            p.run(0.3, () => p.move(0));
            p.run(1.2, () => p.move(direction));
            expect(Math.hypot(p.pawn.velocity[0], p.pawn.velocity[1], p.pawn.velocity[2]), `${TEST_PHYSICS} at speed`).toBeGreaterThan(speed * 0.95);
            const from = Float64Array.from(p.collider.worldPosition);
            p.run(1.5, () => p.move(0));
            return dist(p.collider.worldPosition, from);
        };
        const expected = speed * speed / (2 * a);
        for (const slope of [0, 25.5, 32.1]) for (const direction of [1, -1] as const) {
            const d = stopping(slope, direction);
            expect(Math.abs(d - expected) / expected, `${TEST_PHYSICS} ${slope} deg ${direction > 0 ? 'up' : 'down'}: stopped in ${d.toFixed(3)} m, not ${expected.toFixed(3)}`).toBeLessThan(0.15);
        }
    });

    it('climbs at its commanded speed with an acceleration below g sin(slope)', () => {
        // 4 m/s2 against g sin(32) = 5.2: without the hold it cannot climb at all.
        const climb = (character: Record<string, unknown>) => {
            const p = play(32.1, { acceleration: 4, walkSpeed: 2, ...character });
            p.run(0.3, () => p.move(0));
            p.run(1.5, () => p.move(1));
            // Up the ramp, horizontally: 2 m/s along a 32 degree slope is 1.69.
            return p.pawn.velocity[2];
        };
        expect(climb({}), `${TEST_PHYSICS} held`).toBeGreaterThan(2 * Math.cos(32.1 * DEG) * 0.97);
        expect(climb({ slopeLimit: 0 }), `${TEST_PHYSICS} not held`).toBeLessThan(0.5);
    });

    it('jumps off a slope as high as off the flat', () => {
        const apex = (slope: number) => {
            const p = play(slope, { jumpSpeed: 4 });
            p.run(0.5, () => p.move(0));
            const y0 = p.collider.worldPosition[1];
            let top = y0;
            p.pawn.drive().requests.jump = 0.15;
            p.run(1, () => { p.move(0); top = Math.max(top, p.collider.worldPosition[1]); });
            return top - y0;
        };
        const flat = apex(0);
        expect(flat).toBeGreaterThan(0.6);
        expect(Math.abs(apex(25.5) - flat), `${TEST_PHYSICS}: apex off the slope`).toBeLessThan(0.05);
    });

    it('holds the same in the physics worker as inline', () => {
        if (TEST_PHYSICS !== 'cannon') return;   // the worker parity suites run on cannon
        const p = play(32.1, {}, new LoopbackPort());
        p.run(0.5, () => p.move(0));
        expect(p.physics.executor).toBe('worker');
        const from = Float64Array.from(p.collider.worldPosition);
        p.run(3, () => p.move(0));
        expect(dist(p.collider.worldPosition, from)).toBeLessThan(0.01);
    });
});

describe('PhysicsSystem.holdOnSlope', () => {
    /** A bare capsule on a 30 degree slab, its horizontal speed zeroed every frame as an idle character's is. */
    function idle(hold: boolean, port?: LoopbackPort): number {
        const p = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: TEST_PHYSICS });
        p.initialize();
        (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null };
        played.push(p);
        const slope = 30 * DEG;
        p.addBody(makeBody(box(10, 0.5, 10), { position: [0, -0.5 * Math.cos(slope), 0.5 * Math.sin(slope)], quaternion: [Math.sin(-slope / 2), 0, 0, Math.cos(-slope / 2)], friction: 0.3 }));
        const c: PhysicsBody = makeBody({ kind: 'capsule', radius: R, height: HEIGHT - 2 * R },
            { mass: MASS, angularFactor: [0, 0, 0], friction: 0, character: true, allowSleep: false, position: [0, restHeight(30) + HEIGHT / 2, 0] });
        p.addBody(c);
        if (port) p.setWorkerMode('on', () => port);
        let from: number[] | null = null;
        for (let i = 0; i < 240; i++) {
            p.update(FRAME);
            if (i === 30) from = [c.position.x, c.position.y, c.position.z];
            c.velocity.set(0, c.velocity.y, 0);
            if (hold) p.holdOnSlope(c, 45);
            p.endFrame(FRAME);
        }
        return Math.hypot(c.position.x - from![0], c.position.y - from![1], c.position.z - from![2]);
    }

    it('keeps a body asking for it where it stands, and only that body', () => {
        expect(idle(true), TEST_PHYSICS).toBeLessThan(0.01);
        expect(idle(false), TEST_PHYSICS).toBeGreaterThan(0.05);
    });

    it('holds in the physics worker too', () => {
        if (TEST_PHYSICS !== 'cannon') return;
        expect(idle(true, new LoopbackPort())).toBeLessThan(0.01);
    });

    it('ignores a body that is not dynamic, and a limit of 0', () => {
        const p = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: TEST_PHYSICS });
        p.initialize();
        played.push(p);
        const wall = makeBody(box(1, 1, 1), {});
        p.addBody(wall);
        p.holdOnSlope(wall, 45);
        const c = makeBody({ kind: 'sphere', radius: 0.3 }, { mass: 1 });
        p.addBody(c);
        p.holdOnSlope(c, 0);
        expect((p as any)._holdRequests.size).toBe(0);
    });
});
