import { describe, it, expect } from 'vitest';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { Shape } from '../src/physics/shape';
import { Node } from '../src/core/scene/nodes/node';
import { LoopbackPort } from '../src/physics/worker/ports';
import { BODY_ROW, STATE_STRIDE } from '../src/physics/worker/protocol';

// What the editor's Performance ▸ Workers section reads about the physics worker: `physics.workerStatus`
// (where the step runs, why it came back) and the worker rows of `physics.stats`. None of it may change
// what is simulated; the parity and smoothness tests cover that.

interface Rig { p: PhysicsSystem; hero: Node }

/** One moving body on a node in a stand-in scene, stepped through an in-process worker port. */
function rig(port: LoopbackPort | null): Rig {
    const p = new PhysicsSystem({ gravity: [0, 0, 0] });
    p.initialize();
    const hero = new Node('Hero');
    hero.setBody(70, 0, 0);
    hero.body!.attachShape(Shape.Sphere(0.3));
    (hero as any)._hasStarted = true;
    (p as any)._scene = { nodes: [hero], landscapes: [], tilemaps: [], activeCamera: null };
    if (port) p.setWorkerMode('on', () => port);
    return { p, hero };
}

/** One engine frame, with a script that drives the body at `speed`. */
function frame(r: Rig, speed = 4, dt = 1 / 60): void {
    r.p.update(dt);
    r.hero.updateTransforms();
    r.hero.velocity = [speed, 0, 0];
    r.p.endFrame(dt);
}

describe('physics worker stats', () => {
    it('reports where the step runs and what each step costs', () => {
        const r = rig(new LoopbackPort({ delayFrames: 1 }));
        expect(r.p.workerStatus.state).toBe('worker');
        for (let i = 0; i < 30; i++) frame(r, 4 + Math.sin(i));
        const s = r.p.stats;
        expect(r.p.workerStatus).toMatchObject({ state: 'worker', fallback: null });
        expect(s.workerStepsPosted).toBe(30);
        expect(s.workerFramesLate).toBe(0);
        // The script changes the velocity every frame: one body row out, one back.
        expect(s.workerWrites).toBe(1);
        expect(s.workerOps).toBe(0);
        expect(s.workerBytesUp).toBe((STATE_STRIDE + 2) * 8);
        expect(s.workerBytesDown).toBe(BODY_ROW * 8);
        expect(s.workerDrawn).toBe(1);
        expect(s.workerExtrapolated).toBe(0);
        expect(s.workerRoundTripMs).toBeGreaterThanOrEqual(0);
        expect(s.workerReadyMs).toBeGreaterThanOrEqual(0);
        expect(s.workerLeadMs).toBeCloseTo(1000 / 60, 6);
        expect(s.workerJitterMs).toBeCloseTo(0, 6);
    });

    it('counts late frames, whose bodies are drawn past their step', () => {
        const r = rig(new LoopbackPort({ delayFrames: 1, delayFor: seq => (seq === 12 ? 3 : 1) }));
        const extrapolated: number[] = [];
        for (let i = 0; i < 30; i++) {
            r.p.update(1 / 60);
            extrapolated.push(r.p.stats.workerExtrapolated);
            r.hero.updateTransforms();
            r.hero.velocity = [4, 0, 0];
            r.p.endFrame(1 / 60);
        }
        expect(r.p.stats.workerFramesLate).toBe(2);
        expect(r.p.stats.workerStepsPosted).toBe(28);
        expect(extrapolated.filter(n => n > 0).length).toBeGreaterThanOrEqual(1);
        expect(extrapolated[0]).toBe(0);
    });

    it("reads 'starting' while the worker warms up", () => {
        const r = rig(new LoopbackPort({ delayFrames: 1, delayFor: seq => (seq === 1 ? 5 : 1) }));
        expect(r.p.workerStatus.state).toBe('starting');
        expect(r.p.executor).toBe('inline');
        for (let i = 0; i < 6; i++) frame(r);
        expect(r.p.workerStatus.state).toBe('worker');
    });

    it('keeps why the step came back to the main thread, until the mode is set again', () => {
        const r = rig(new LoopbackPort({ delayFrames: 1, failAt: 5 }));
        for (let i = 0; i < 10; i++) frame(r);
        expect(r.p.workerStatus.state).toBe('inline');
        expect(r.p.workerStatus.fallback).toMatch(/^The worker failed: .*injected failure/);
        r.p.setWorkerMode('on', () => new LoopbackPort({ delayFrames: 1 }));
        expect(r.p.workerStatus).toMatchObject({ state: 'worker', fallback: null });
    });

    it('says so when the host cannot make a worker', () => {
        const r = rig(null);
        r.p.setWorkerMode('auto', null);
        expect(r.p.workerStatus).toMatchObject({ state: 'inline', fallback: 'This host has no physics worker.' });
        r.p.setWorkerMode('off', null);
        expect(r.p.workerStatus.fallback).toBeNull();
    });

    it('Auto rides out a hitch, moves back only when the worker stays behind, and tries it again later', () => {
        // 40 moving bodies: what makes Auto want the worker. `slow` holds every step two frames (half late).
        let slow = false;
        const p = new PhysicsSystem({ gravity: [0, 0, 0] });
        p.initialize();
        const nodes: Node[] = [];
        for (let i = 0; i < 40; i++) {
            const n = new Node(`B${i}`);
            n.setBody(1, 0, 0);
            n.body!.attachShape(Shape.Sphere(0.2));
            n.setWorldPosition([i * 2, 0, 0]);
            (n as any)._hasStarted = true;
            nodes.push(n);
        }
        (p as any)._scene = { nodes, landscapes: [], tilemaps: [], activeCamera: null };
        p.setWorkerMode('auto', () => new LoopbackPort({ delayFrames: 1, delayFor: () => (slow ? 2 : 1) }));
        const run = (seconds: number) => {
            for (let i = 0; i < Math.round(seconds * 60); i++) {
                p.update(1 / 60);
                for (const n of nodes) { n.updateTransforms(); n.velocity = [1, 0, 0]; }
                p.endFrame(1 / 60);
            }
        };
        run(2.5);
        expect(p.workerStatus.state).toBe('worker');
        slow = true;
        run(3.2);                                   // one bad window: a hitch, ridden out
        expect(p.workerStatus.state).toBe('worker');
        slow = false;
        run(3.2);
        slow = true;
        run(6.2);                                   // two in a row: back to the main thread
        expect(p.workerStatus.state).toBe('inline');
        expect(p.workerStatus.fallback).toMatch(/fell behind/);
        slow = false;
        run(20);
        expect(p.workerStatus.state).toBe('inline'); // waiting out the retry delay
        run(12);
        expect(p.workerStatus.state).toBe('worker'); // and trying again
        expect(p.workerStatus.fallback).toBeNull();
    });
});
