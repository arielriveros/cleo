import { describe, it, expect } from 'vitest';
import { quat } from 'gl-matrix';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { Shape } from '../src/physics/shape';
import { Node } from '../src/core/scene/nodes/node';
import { LoopbackPort } from '../src/physics/worker/ports';

// With the physics step in a worker, how bodies LOOK. The step is posted before the frame that draws it
// has started, so the worker reaches one predicted frame ahead and each node is drawn at its frame's actual
// time, interpolated between the step's two ends (physics/backend/workerBackend.ts). These pin what that
// buys and what it must not break: steady motion on uneven frames and through late steps, scripts that
// move or turn a node by an amount (root motion, a character's turn), writes made while a step ran.
//
// Before: stepping each frame by the PREVIOUS frame's delta drew a body at 25–45 ms frames with a 26% rms
// error in its on-screen speed (78% worst), and a late step froze it for a frame and jumped it double.

const SPEED = 4;

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
const random = rng(7);
const UNEVEN = Array.from({ length: 400 }, () => 0.025 + 0.02 * random());   // the editor's dev server: 25–45 ms
const HZ144 = Array.from({ length: 400 }, () => 1 / 144 + (random() - 0.5) * 0.001);
const STEADY = Array.from({ length: 400 }, () => 1 / 60);

interface Rig { p: PhysicsSystem; hero: Node; port: LoopbackPort | null }

/** One body on a node in a stand-in scene, stepped inline or through an in-process worker port. */
function rig(mode: 'inline' | 'worker', options: { gravity?: number; fixedRotation?: boolean; delayFor?: (seq: number) => number } = {}): Rig {
    const p = new PhysicsSystem({ gravity: [0, -(options.gravity ?? 0), 0] });
    p.initialize();
    const hero = new Node('Hero');
    hero.setBody(70, 0, 0, undefined, options.fixedRotation ? [0, 0, 0] : undefined);
    hero.body!.attachShape(Shape.Sphere(0.3));
    (hero as any)._hasStarted = true;
    (p as any)._scene = { nodes: [hero], landscapes: [], tilemaps: [], activeCamera: null };
    let port: LoopbackPort | null = null;
    if (mode === 'worker') {
        // A reply lands at the next frame's start (on time) unless delayFor holds it longer.
        port = new LoopbackPort({ delayFrames: 1, delayFor: options.delayFor });
        p.setWorkerMode('on', () => port!);
    }
    return { p, hero, port };
}

/** One engine frame: physics, the transform pass, the "scripts", the frame's end. `scale`/`next`: the engine's time scale this frame and next. */
function frame(r: Rig, dt: number, script?: () => void, scale = 1, next = 1): void {
    r.p.update(dt, scale);
    r.hero.updateTransforms();
    script?.();
    r.p.endFrame(dt, next);
}

/** Drive at constant speed; the on-screen speed error per frame, relative to the speed. */
function drawnSpeedError(r: Rig, dts: number[]): { rms: number; worst: number } {
    const xs: number[] = [];
    for (const dt of dts) frame(r, dt, () => { xs.push(r.hero.worldPosition[0]); r.hero.velocity = [SPEED, 0, 0]; });
    const errs: number[] = [];
    // From frame 80: the worker's drawing settles one frame behind the clock over its first second (at most
    // 2% slow), which is what a game sees once, when the step moves to the worker.
    for (let k = 80; k < dts.length; k++) errs.push(((xs[k] - xs[k - 1]) / dts[k] - SPEED) / SPEED);
    return { rms: Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length), worst: Math.max(...errs.map(Math.abs)) };
}

const yawOf = (q: ArrayLike<number>) => {
    // +Z rotated by q, then its heading — what CharacterNode reads off worldForward.
    const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
    const fx = 2 * (x * z + w * y), fz = 1 - 2 * (x * x + y * y);
    return Math.atan2(fx, fz) * 180 / Math.PI;
};

describe('drawing a body stepped in the worker', () => {
    it('moves steadily on uneven frames, as inline does', () => {
        const inline = drawnSpeedError(rig('inline'), UNEVEN);
        const worker = drawnSpeedError(rig('worker'), UNEVEN);
        expect(inline.rms).toBeLessThan(1e-4);
        expect(worker.rms).toBeLessThan(0.03);
        expect(worker.worst).toBeLessThan(0.08);
        const fast = drawnSpeedError(rig('worker'), HZ144);
        expect(fast.rms).toBeLessThan(0.01);
    });

    it('carries on through a late step instead of freezing and jumping', () => {
        const late = (seq: number) => (seq % 20 === 7 ? 2 : 1);   // one step in twenty misses its frame
        const r = rig('worker', { delayFor: late });
        const uneven = drawnSpeedError(r, UNEVEN);
        expect((r.p as any)._backend.lateFrames).toBeGreaterThan(15);
        expect(uneven.worst).toBeLessThan(0.08);
        // Steady frames: a late step moves the drawn time a little further behind, at most 2% slow meanwhile.
        expect(drawnSpeedError(rig('worker', { delayFor: late }), STEADY).worst).toBeLessThan(0.025);
    });

    it('keeps the time of a reply that missed several slow frames, instead of drawing a stall', () => {
        // Four 25–45 ms frames late (a fight's busy frames, a GC pause): over 0.1 s owed at once. Dropping the
        // excess drew the body standing still for it and then moving on: 247% worst, 22% rms.
        const stalls = (seq: number) => (seq % 40 === 13 ? 4 : 1);
        const jumpy = (seq: number) => 1 + (seq * 7919 % 3);          // every reply 1–3 frames after its post
        for (const delayFor of [stalls, jumpy]) {
            const e = drawnSpeedError(rig('worker', { delayFor }), [...UNEVEN, ...UNEVEN]);
            expect(e.worst).toBeLessThan(0.05);
        }
    });

    it('lets scripts read the body at this frame’s time, as inline', () => {
        const a = rig('inline'), b = rig('worker');
        for (let i = 0; i < 100; i++) {
            frame(a, 1 / 60, () => { a.hero.velocity = [SPEED, 0, 0]; });
            frame(b, 1 / 60, () => { b.hero.velocity = [SPEED, 0, 0]; });
        }
        a.p.update(1 / 60); b.p.update(1 / 60);
        // To float32: inline, the node write-back pushes the node's (float32) pose into the body every
        // frame; the worker's drawn pose never touches the body.
        expect(b.hero.body!.position.x).toBeCloseTo(a.hero.body!.position.x, 4);
    });

    it('draws a teleport at once', () => {
        const r = rig('worker');
        for (let i = 0; i < 60; i++) frame(r, 1 / 60, () => { r.hero.velocity = [SPEED, 0, 0]; });
        frame(r, 1 / 60, () => { r.hero.body!.position.set(50, 0, 0); r.hero.body!.aabbNeedsUpdate = true; });
        frame(r, 1 / 60);
        expect(Math.abs(r.hero.worldPosition[0] - 50)).toBeLessThan(2 * SPEED / 60);
        const r2 = rig('worker');
        for (let i = 0; i < 60; i++) frame(r2, 1 / 60, () => { r2.hero.velocity = [SPEED, 0, 0]; });
        frame(r2, 1 / 60, () => r2.hero.setWorldPosition([-20, 0, 0]));
        frame(r2, 1 / 60);
        expect(Math.abs(r2.hero.worldPosition[0] + 20)).toBeLessThan(2 * SPEED / 60);
    });

    it('turns a node a script turns every frame at the rate it is told', () => {
        // CharacterNode's turn: read the facing off the (drawn) node, add this frame's turn, write it back.
        // Measured against the drawn pose, such a write would drag the body back by the drawing's lag
        // every frame and turn it slower; the node's gap carries it to the body (Node._bodyOffset).
        const RATE = 90;                                  // degrees per second, for one second
        for (const mode of ['inline', 'worker'] as const) {
            const r = rig(mode, { fixedRotation: true });
            let t = 0;
            for (const dt of UNEVEN) {
                if (t >= 1) break;
                t += dt;
                frame(r, dt, () => {
                    const f = r.hero.worldForward;
                    const yaw = Math.atan2(f[0], f[2]) * 180 / Math.PI + RATE * dt;
                    r.hero.setWorldQuaternion(quat.fromEuler(quat.create(), 0, yaw, 0));
                });
            }
            const q = r.hero.body!.quaternion;
            expect(yawOf([q.x, q.y, q.z, q.w]), mode).toBeCloseTo(RATE * t, 0);
        }
    });

    it('moves a node a script moves every frame by exactly what it adds, on top of the simulation', () => {
        // Root motion on a falling body: read the (drawn) node position, add the clip's travel, write it
        // back. Measured against the drawn pose, that write would also drag the body back up by the
        // drawing's lag every frame — 15% less fall here. The node's gap carries the write to the body.
        const run = (mode: 'inline' | 'worker') => {
            const r = rig(mode, { gravity: 9.81 });
            for (let i = 0; i < 60; i++) frame(r, UNEVEN[i], () => {
                const wp = r.hero.worldPosition;
                r.hero.setWorldPosition([wp[0] + 0.05, wp[1], wp[2]]);
            });
            return r.hero.body!.position;
        };
        const inline = run('inline'), worker = run('worker');
        expect(worker.x).toBeCloseTo(3, 4);
        expect(inline.y).toBeLessThan(-18);
        expect(Math.abs(worker.y - inline.y)).toBeLessThan(0.5);
    });

    it('turns a free body a script turns, on top of its spin', () => {
        // Same, for rotation: a spinning body that a script also turns (a weapon, a prop) keeps both.
        const run = (mode: 'inline' | 'worker') => {
            const r = rig(mode);
            r.hero.body!.angularVelocity.set(0, 1, 0);      // 57 degrees a second about up
            for (let i = 0; i < 40; i++) frame(r, UNEVEN[i], () => {
                const q = r.hero.worldQuaternion;
                const turn = quat.setAxisAngle(quat.create(), [0, 1, 0], 0.02);
                r.hero.setWorldQuaternion(quat.multiply(quat.create(), turn, q));
            });
            const q = r.hero.body!.quaternion;
            return yawOf([q.x, q.y, q.z, q.w]);
        };
        const inline = run('inline'), worker = run('worker');
        expect(Math.abs(worker - inline)).toBeLessThan(3);
    });

    it('keeps the step’s fall under a velocity written while the step ran', () => {
        // Steering writes velocity.x every frame; on a frame whose diff waits for a late step, that write is
        // still in the mirror when the step lands, and must not throw away the step's vertical velocity.
        const run = (mode: 'inline' | 'worker') => {
            const r = rig(mode, { gravity: 9.81, delayFor: seq => (seq % 3 === 0 ? 2 : 1) });
            for (let i = 0; i < 60; i++) frame(r, 1 / 60, () => { r.hero.body!.velocity.x = 2 + Math.sin(i); });
            return r;
        };
        const inline = run('inline'), worker = run('worker');
        expect((worker.p as any)._backend.lateFrames).toBeGreaterThan(10);
        // Throwing the whole velocity away on each of those frames loses 20 × g/60 ≈ 3.3 m/s of fall.
        expect(Math.abs(worker.hero.body!.velocity.y - inline.hero.body!.velocity.y)).toBeLessThan(0.5);
        expect(worker.hero.body!.velocity.x).toBe(2 + Math.sin(59));
    });
});

describe('handing the step to the worker', () => {
    it('keeps stepping on this thread until the worker has answered, so no frame freezes', () => {
        const r = rig('worker', { delayFor: seq => (seq === 1 ? 10 : 1) });   // the warm-up answers 10 frames late
        expect(r.p.backend).toBe('inline');
        const xs: number[] = [], kinds: string[] = [];
        for (let i = 0; i < 40; i++) frame(r, 1 / 60, () => { xs.push(r.hero.worldPosition[0]); kinds.push(r.p.backend); r.hero.velocity = [SPEED, 0, 0]; });
        expect(kinds[5]).toBe('inline');
        expect(kinds[39]).toBe('worker');
        // The frames before were drawn at the clock (inline); the worker's drawing settles one frame behind
        // by running at most 2% slow meanwhile — never a frozen or a doubled frame.
        for (let k = 3; k < xs.length; k++) expect(Math.abs((xs[k] - xs[k - 1]) / (SPEED / 60) - 1), `frame ${k}`).toBeLessThan(0.025);
    });

    it('the first step after taking over mid-game covers the frame, like every other', () => {
        const r = rig('worker', { delayFor: seq => (seq === 1 ? 8 : 1) });
        const xs: number[] = [], kinds: string[] = [];
        // The body as scripts read it (the latest simulated pose), not just as drawn: no frame without a step.
        for (let i = 0; i < 20; i++) frame(r, 1 / 60, () => { xs.push(r.hero.body!.position.x); kinds.push(r.p.backend); r.hero.velocity = [SPEED, 0, 0]; });
        expect(kinds.indexOf('worker')).toBeGreaterThan(4);
        for (let k = 2; k < xs.length; k++) expect(xs[k] - xs[k - 1], `frame ${k}`).toBeCloseTo(SPEED / 60, 6);
    });

    it('still hands over when the scene is cleared during the warm-up', () => {
        const r = rig('worker', { delayFor: seq => (seq === 1 ? 5 : 1) });
        frame(r, 1 / 60);
        r.p.clear();
        for (let i = 0; i < 10; i++) frame(r, 1 / 60);
        expect(r.p.backend).toBe('worker');
    });
});

describe('a hit-stop (the engine time scale dropping for a few frames)', () => {
    // 1/60 frames at a time scale that drops to 0.2 for six frames, twice: CleoEngine hands physics the
    // scaled delta, the scale, and the scale the next frame starts at (the hit landed in this frame's scripts).
    const SCALES = Array.from({ length: 240 }, (_, i) => ((i >= 120 && i < 126) || (i >= 180 && i < 186) ? 0.2 : 1));
    const run = (r: Rig, xs?: number[]) => SCALES.forEach((s, i) =>
        frame(r, s / 60, () => { xs?.push(r.hero.worldPosition[0]); r.hero.velocity = [SPEED, 0, 0]; }, s, SCALES[i + 1] ?? 1));

    it('simulates exactly the scaled time, as inline does', () => {
        const a = rig('inline'), b = rig('worker');
        run(a); run(b);
        a.p.update(1 / 60); b.p.update(1 / 60);
        expect(b.hero.body!.position.x).toBeCloseTo(a.hero.body!.position.x, 4);
    });

    it('draws the slow-down and the return at the scaled speed, without a jump', () => {
        const xs: number[] = [];
        run(rig('worker'), xs);
        for (let k = 90; k < SCALES.length; k++) {
            const speed = (xs[k] - xs[k - 1]) / (SCALES[k] / 60);
            expect(Math.abs(speed - SPEED) / SPEED, `frame ${k}`).toBeLessThan(0.02);
        }
    });
});

describe('results that take more than a frame to come back (a high refresh rate, a busy main thread)', () => {
    /** Drawn motion under a steering script (speed swinging 2..6 m/s), with every reply `delay` frames late. */
    function steer(mode: 'inline' | 'worker', hz: number, delay: number): number[] {
        const r = rig(mode, { delayFor: () => delay });
        const dt = 1 / hz, xs: number[] = [];
        for (let i = 0; i < 6 * hz; i++) frame(r, dt, () => { xs.push(r.hero.worldPosition[0]); r.hero.velocity = [4 + 2 * Math.sin(i * dt * 3), 0, 0]; });
        return xs;
    }
    /** How far each frame's drawn step strays from the average of its neighbours, relative to the step: jitter. */
    function jitter(xs: number[]): number {
        const d = xs.slice(1).map((x, k) => x - xs[k]);
        let worst = 0;
        for (let k = Math.floor(d.length / 3); k < d.length - 1; k++) worst = Math.max(worst, Math.abs(d[k] - (d[k - 1] + d[k + 1]) / 2) / d[k]);
        return worst;
    }

    for (const hz of [60, 144]) for (const delay of [1, 2, 3]) {
        it(`moves as smoothly as inline at ${hz} Hz with replies ${delay} frame(s) after their post`, () => {
            const inline = jitter(steer('inline', hz, delay));
            const worker = jitter(steer('worker', hz, delay));
            // A reply every frame: as smooth as inline. Every second or third frame: the worker only hears the
            // script's steering that often, so its path really is coarser — but drawn without a stall or a jump.
            expect(worker).toBeLessThan(Math.max(delay === 1 ? 0.01 : 0.04, 3 * inline));
        });
    }
});
