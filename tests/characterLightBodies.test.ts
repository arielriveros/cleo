import { describe, it, expect } from 'vitest';
import { makeBody, box, sphere } from './helpers/physicsBodies';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import type { PhysicsBody } from '../src/physics/physicsBody';
import { LoopbackPort } from '../src/physics/worker/ports';
import { TEST_PHYSICS } from './helpers/testPhysics';

// A character is not pushed about by bodies lighter than it (physics/characterContacts.ts). The report: "when I
// jump to a box and it rotates while I am still in the air, the corner of the box lifts me", on every backend,
// although the character is 75 kg and the box 8. A light body backed by the ground deflects a character up as a
// wall's edge would, and a box tipping under it raises it on its corner; now light bodies may stop and hold a
// character but move it only by their share of the two masses. Runs on every backend (vitest.config.ts).
//
// Measured before the rule, jumping into the edge of an 8 kg box (the worst start of a sweep): cannon rose 12-17 cm
// above the jump's own apex, Rapier up to 5.5 cm, Jolt 2 cm; a 25 kg box 22 cm (cannon), 12 (Rapier), 8 (Jolt). A 3 kg
// ball thrown at 8 m/s slid the (frictionless, uncontrolled) character 40 cm.

const FRAME = 1 / 60;
/** The Sandbox's character: a 0.28 m capsule (tip to tip 1.76 m), 75 kg, upright, frictionless. */
const R = 0.28, STRAIGHT = 1.2, HALF = R + STRAIGHT / 2, MASS = 75;
/** Its jump: 3 m/s up while jogging at 3.8 m/s, an apex 0.46 m up. */
const JUMP = 3, JOG = 3.8, APEX = JUMP * JUMP / (2 * 9.81);

function physics(worker?: LoopbackPort): PhysicsSystem {
    const p = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: TEST_PHYSICS });
    p.initialize();
    (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null };
    p.addBody(makeBody(box(10, 0.5, 10), { position: [0, -0.5, 0], friction: 0.3 }));
    if (worker) p.setWorkerMode('on', () => worker);
    return p;
}

function character(p: PhysicsSystem, x: number, y = 0): PhysicsBody {
    const c = makeBody({ kind: 'capsule', radius: R, height: STRAIGHT },
        { mass: MASS, angularFactor: [0, 0, 0], friction: 0, character: true, allowSleep: false, position: [x, y + HALF, 0] });
    p.addBody(c);
    return c;
}

function crate(p: PhysicsSystem, size: number, mass: number, x = 0, y = 0): PhysicsBody {
    const b = makeBody(box(size / 2, size / 2, size / 2), { mass, position: [x, y + size / 2, 0], friction: 0.5 });
    p.addBody(b);
    return b;
}

const feet = (c: PhysicsBody) => c.position.y - HALF;

function frames(p: PhysicsSystem, n: number, each?: (i: number) => void): void {
    for (let i = 0; i < n; i++) { p.update(FRAME); each?.(i); p.endFrame(FRAME); }
}

/** The highest the character's feet get, jumping from `start` into a box of `size` and `mass` at the origin. */
function jumpInto(size: number, mass: number, start: number): number {
    const p = physics();
    crate(p, size, mass);
    const c = character(p, start);
    c.velocity.set(JOG, JUMP, 0);
    let top = 0;
    frames(p, 90, () => { top = Math.max(top, feet(c)); });
    (p as any)._world.dispose();
    return top;
}

/** The worst of a sweep of take-off points in front of a box, the box's top edge met rising and falling. */
function worstJumpInto(size: number, mass: number): number {
    let worst = -Infinity;
    for (let start = -2.4; start <= -0.6 + 1e-9; start += 0.1) worst = Math.max(worst, jumpInto(size, mass, start) - Math.max(APEX, size));
    return worst;
}

describe('a character and the bodies lighter than it', () => {
    it('is not lifted by the edge of a light box it jumps into', () => {
        for (const size of [0.3, 0.4, 0.5]) {
            const lift = worstJumpInto(size, 8);
            expect(lift, `${TEST_PHYSICS}: an 8 kg box of ${size} m lifted the character ${(lift * 100).toFixed(1)} cm past its jump`).toBeLessThan(0.02);
        }
        // A heavier box gives it more (a third, at 25 kg), as its share of the masses says.
        expect(worstJumpInto(0.4, 25)).toBeLessThan(0.1);
    });

    it('is still deflected up by an edge that does not move: the rule is about mass, not edges', () => {
        // A capsule meeting a fixed edge rides up it; that is the shape, and it is left alone.
        expect(worstJumpInto(0.4, 0)).toBeGreaterThan(0.1);
    });

    it('is not thrown up by a light box tipping under it', () => {
        // Drop onto a 0.5 m box, moving on, across its top: landing off-centre tips it under the character. Measured
        // before the rule, Rapier threw the character up to 20 cm above the box's top.
        let worst = -Infinity, at = '';
        for (const x of [-0.3, -0.2, -0.1, 0]) for (const vx of [1, 2, 3]) {
            const p = physics();
            crate(p, 0.5, 8);
            const c = character(p, x, 1.4);
            c.velocity.set(vx, 0, 0);
            let landed = false, top = -Infinity;
            frames(p, 90, () => {
                const y = feet(c);
                landed ||= y < 0.52;
                if (landed) top = Math.max(top, y);
            });
            (p as any)._world.dispose();
            expect(landed, `x ${x}, ${vx} m/s`).toBe(true);
            if (top - 0.5 > worst) { worst = top - 0.5; at = `landing at x ${x}, ${vx} m/s`; }
        }
        expect(worst, `${TEST_PHYSICS}: rose ${(worst * 100).toFixed(1)} cm above the box, ${at}`).toBeLessThan(0.03);
    });

    it('can still stand on a light box: it holds the character up', () => {
        const p = physics();
        crate(p, 0.5, 8);
        const c = character(p, 0, 0.52);
        frames(p, 180);
        // Rapier and Jolt settle 2 mm in. cannon's solver lets an 8 kg box under 75 kg sink about a centimetre
        // into the floor in 3 s on its own, and the character with it.
        expect(Math.abs(feet(c) - 0.5), `${TEST_PHYSICS}: feet at ${feet(c).toFixed(3)} on a 0.5 m box`).toBeLessThan(TEST_PHYSICS === 'cannon' ? 0.025 : 0.005);
    });

    it('still jumps off a light box at full speed', () => {
        const p = physics();
        crate(p, 0.5, 8);
        const c = character(p, 0, 0.5);
        frames(p, 30);
        c.velocity.set(0, JUMP, 0);
        let top = 0;
        frames(p, 40, () => { top = Math.max(top, feet(c)); });
        expect(top).toBeGreaterThan(0.5 + APEX - 0.05);
    });

    it('still pushes a light box along', () => {
        const p = physics();
        const b = crate(p, 0.8, 25, 0);
        const c = character(p, -1);
        const from = b.position.x;
        frames(p, 90, () => { const v = c.velocity; c.velocity.set(JOG, v.y, 0); });
        expect(b.position.x - from).toBeGreaterThan(0.3);
        expect(feet(c)).toBeLessThan(0.02);
    });

    it('is barely moved by a light ball thrown at it, and still shoved by a heavy block', () => {
        const hit = (mass: number, radius: number) => {
            const p = physics();
            const c = character(p, 0);
            frames(p, 10);
            const ball = makeBody(sphere(radius), { mass, position: [-1.5, 1.0, 0], restitution: 0.5, friction: 0.3 });
            p.addBody(ball);
            ball.velocity.set(8, 0, 0);
            const from = c.position.x;
            frames(p, 60);
            const moved = Math.abs(c.position.x - from);
            (p as any)._world.dispose();
            return moved;
        };
        const light = hit(3, 0.25);
        expect(light, `${TEST_PHYSICS}: a 3 kg ball moved the character ${(light * 100).toFixed(1)} cm`).toBeLessThan(0.05);
        // 300 kg: heavier than the character, so no share is taken back.
        expect(hit(300, 0.5)).toBeGreaterThan(0.3);
    });

    it('steps the same in the physics worker as inline', () => {
        const run = (port?: LoopbackPort) => {
            const p = physics(port);
            crate(p, 0.4, 8);
            const c = character(p, -0.9);
            c.velocity.set(JOG, JUMP, 0);
            const out: number[][] = [];
            frames(p, 61, () => out.push([c.position.x, c.position.y, c.velocity.x, c.velocity.y]));
            if (port) expect(p.executor).toBe('worker');
            return out;
        };
        const inline = run();
        const worker = run(new LoopbackPort());
        // The worker's step lands one frame after it was posted (physicsWorkerParity.test.ts).
        for (let i = 0; i < 60; i++) expect(worker[i + 1], `frame ${i}`).toEqual(inline[i]);
    });
});
