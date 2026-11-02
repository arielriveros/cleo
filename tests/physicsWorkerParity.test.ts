import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { Body, Box, ConeTwistConstraint, ConvexPolyhedron, Cylinder, Heightfield, HingeConstraint, LockConstraint, Plane, PointToPointConstraint, Sphere, Trimesh, Vec3 } from 'cannon-es';
import { runScenario, scenarioPhysics } from './helpers/physicsScenario';
import { LoopbackPort } from '../src/physics/worker/ports';
import { decodeConstraint, decodeShape, encodeConstraint, encodeShape } from '../src/physics/worker/bodyCodec';
import type { PhysicsSystem } from '../src/physics/physicsSystem';

// The physics step in a Web Worker (physics/backend/workerBackend.ts + physics/worker/) must simulate
// EXACTLY what the inline step does. These run the mixed scene of the golden trace through the worker
// backend — over an in-process port that clones every message like a real worker does — and compare
// bit for bit. The worker's result lands one frame after the scripts that caused it, so its trace is
// read with that one-frame lag; the simulated state each script sees is the same.

function workerPhysics(port: LoopbackPort): PhysicsSystem {
    const p = scenarioPhysics();
    p.setWorkerMode('on', () => port);
    return p;
}

describe('the worker backend', () => {
    it('steps the mixed scene exactly like the inline backend', () => {
        const inline = runScenario(scenarioPhysics());
        const port = new LoopbackPort();
        const p = workerPhysics(port);
        expect(p.backend).toBe('worker');
        const worker = runScenario(p, 300, 1 / 60, 1);
        expect(p.backend).toBe('worker');
        expect(worker.triggers).toEqual(inline.triggers);
        expect(worker.collides).toEqual(inline.collides);
        expect(worker.grounded).toEqual(inline.grounded);
        expect(worker.frozen).toEqual(inline.frozen);
        expect(worker.states.length).toBe(inline.states.length);
        for (let i = 0; i < inline.states.length; i++) expect(worker.states[i], `frame ${i * 10}`).toEqual(inline.states[i]);
    });

    it('keeps going when the worker is late: no lost writes, no lost time, no double steps', () => {
        const port = new LoopbackPort({ delayFrames: 2 });
        const p = workerPhysics(port);
        const trace = runScenario(p, 300, 1 / 60, 1);
        const backend = (p as any)._backend;
        expect(backend.lateFrames).toBeGreaterThan(50);
        // The velocity the "script" writes every frame still walks the character through the zone.
        expect(trace.triggers).toEqual(['Zone enter Hero', 'Zone exit Hero']);
        // Time is carried, not dropped: the worker's clock is the frames' time minus the step in flight
        // and the time still pending.
        const simulated = port.core.world.time;
        const total = 301 / 60;
        expect(simulated).toBeGreaterThan(total - 3 / 60 - 1e-9);
        expect(simulated).toBeLessThanOrEqual(total + 1e-9);
    });

    it('falls back to the inline step when the worker fails, carrying on from its last step', () => {
        const port = new LoopbackPort({ failAt: 120 });
        const p = workerPhysics(port);
        const trace = runScenario(p, 300, 1 / 60, 1);
        expect(p.backend).toBe('inline');
        // The scene went on: the character still crossed the zone, and the far body still froze and thawed.
        expect(trace.triggers).toEqual(['Zone enter Hero', 'Zone exit Hero']);
        expect(trace.frozen.slice(160, 230).some(f => !f)).toBe(true);
        // Nothing jumped: the character's x moves at most a frame's travel between samples.
        const heroX = trace.states.map(row => row[11 * 13]);
        for (let i = 1; i < heroX.length; i++) expect(Math.abs(heroX[i] - heroX[i - 1])).toBeLessThan(2 * 10 / 60 + 0.05);
    });

    it('a cleared world starts the worker over (a scene change mid-run)', () => {
        const port = new LoopbackPort();
        const p = workerPhysics(port);
        runScenario(p, 30, 1 / 60, 1);
        expect(port.core.world.bodies.length).toBeGreaterThan(10);
        p.clear();
        p.update(1 / 60); p.endFrame(1 / 60); p.update(1 / 60);
        expect(port.core.world.bodies.length).toBe(0);
        // And it fills again from what the new scene adds.
        const b = new Body({ mass: 1, position: new Vec3(0, 5, 0) });
        b.addShape(new Sphere(0.5));
        p.addBody(b);
        p.endFrame(1 / 60); p.update(1 / 60);
        expect(port.core.world.bodies.length).toBe(1);
        expect(b.position.y).toBeLessThan(5);
    });
});

describe('the body codec', () => {
    const roundTrip = (shape: any) => decodeShape(encodeShape(shape)!) as any;

    it('rebuilds every shape kind exactly', () => {
        expect(roundTrip(new Sphere(0.7)).radius).toBe(0.7);
        expect(roundTrip(new Box(new Vec3(1, 2, 3))).halfExtents).toEqual(new Vec3(1, 2, 3));
        const cyl = roundTrip(new Cylinder(0.3, 0.4, 1.2, 10));
        expect([cyl.radiusTop, cyl.radiusBottom, cyl.height, cyl.numSegments]).toEqual([0.3, 0.4, 1.2, 10]);
        expect(cyl.vertices).toEqual(new Cylinder(0.3, 0.4, 1.2, 10).vertices);
        const hull = new ConvexPolyhedron({ vertices: [new Vec3(0, 0, 0), new Vec3(1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 0, 1)], faces: [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]] });
        const h2 = roundTrip(hull);
        expect(h2.vertices).toEqual(hull.vertices);
        expect(h2.faces).toEqual(hull.faces);
        expect(h2.faceNormals).toEqual(hull.faceNormals);
        expect(roundTrip(new Plane()).type).toBe(new Plane().type);
        const field = new Heightfield([[0, 0.5, 1], [0.25, 0.75, 0.1]], { elementSize: 2 });
        const f2 = roundTrip(field);
        expect([f2.data, f2.elementSize, f2.minValue, f2.maxValue]).toEqual([field.data, 2, field.minValue, field.maxValue]);
        const mesh = new Trimesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
        mesh.setScale(new Vec3(2, 2, 2));
        const m2 = roundTrip(mesh);
        expect(Array.from(m2.vertices)).toEqual(Array.from(mesh.vertices));
        expect(m2.scale).toEqual(new Vec3(2, 2, 2));
    });

    it('rebuilds every constraint a ragdoll uses', () => {
        const a = new Body({ mass: 1, position: new Vec3(0, 1, 0) }), b = new Body({ mass: 1, position: new Vec3(0, 0, 0) });
        const slots = new Map([[a, 0], [b, 1]]);
        const bodies = [a, b];
        const opts = { pivotA: new Vec3(0, -0.5, 0), pivotB: new Vec3(0, 0.5, 0), axisA: Vec3.UNIT_X, axisB: Vec3.UNIT_X };
        for (const c of [
            new PointToPointConstraint(a, new Vec3(0, -0.5, 0), b, new Vec3(0, 0.5, 0), 50),
            new ConeTwistConstraint(a, b, { ...opts, angle: 0.4, twistAngle: 0.2, maxForce: 80 }),
            new HingeConstraint(a, b, { ...opts, maxForce: 90 }),
            new LockConstraint(a, b, { maxForce: 70 }),
        ]) {
            const def = encodeConstraint(c, x => slots.get(x))!;
            expect(def, c.constructor.name).toBeTruthy();
            const back = decodeConstraint(def, s => bodies[s]) as any;
            expect(back.constructor).toBe(c.constructor);
            expect(back.equations.length).toBe(c.equations.length);
            expect(back.equations.map((e: any) => e.maxForce)).toEqual(c.equations.map((e: any) => e.maxForce));
            for (const k of ['pivotA', 'pivotB', 'axisA', 'axisB', 'angle', 'twistAngle']) if (k in c) expect(back[k], `${c.constructor.name}.${k}`).toEqual((c as any)[k]);
        }
    });
});

describe('the worker bundle', () => {
    it('imports nothing beyond cannon-es and the physics leaf modules (no engine barrel, no window)', () => {
        const root = resolve(__dirname, '..', 'src', 'physics', 'worker', 'physicsWorker.ts');
        const seen = new Set<string>();
        const bare = new Set<string>();
        const visit = (file: string) => {
            if (seen.has(file)) return;
            seen.add(file);
            const src = readFileSync(file, 'utf8');
            for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
                const spec = m[1];
                if (!spec.startsWith('.')) { bare.add(spec); continue; }
                const base = resolve(dirname(file), spec);
                const next = [base + '.ts', join(base, 'index.ts')].find(existsSync);
                if (next) visit(next);
            }
        };
        visit(root);
        expect([...bare]).toEqual(['cannon-es']);
        const files = [...seen].map(f => f.replace(/\\/g, '/'));
        for (const f of files) expect(f, f).toMatch(/\/src\/physics\//);
        expect(files.some(f => /\/(core|graphics|animation)\//.test(f) || f.endsWith('/cleo.ts'))).toBe(false);
    });
});
