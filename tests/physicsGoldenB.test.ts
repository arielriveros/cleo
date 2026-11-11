import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { readExample } from '../tools/exampleKit/readExample.mjs';
import { AnimatedModel } from '../src/animation/animatedModel';
import { ModelNode } from '../src/core/scene/nodes/modelNode';
import { setGLContext } from '../src/graphics/rhi/webgl2/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { LoopbackPort } from '../src/physics/worker/ports';
import { runScenarioB, scenarioBPhysics, type ScenarioBTrace } from './helpers/physicsScenarioB';

// Scene B (tests/helpers/physicsScenarioB.ts), pinned bit for bit: offset centres of mass, a body created
// rotated, continuous trigger contacts with their points and fractions, a profile ragdoll, pooled foliage,
// buoyancy on a cylinder, and every query. Twice inline (a steady 60 Hz, and uneven frames that take
// several substeps) and once through the worker, which must match the steady inline run exactly. If a
// change to the physics is MEANT to change these, delete the fixture, re-run to record, and say why.

const FIXTURE = join(__dirname, 'fixtures', 'physicsGoldenB.json');
const UNEVEN = [1 / 60, 1 / 30, 1 / 45, 1 / 90, 0.05];

let modelJson: any;
beforeAll(async () => {
    // The stub context ragdollProfile.test.ts uses: building an AnimatedModel touches the device.
    let n = 0;
    const constants: Record<string, number> = {
        UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
    };
    const objects = new Set(['createVertexArray', 'createBuffer', 'createTexture']);
    const gl = new Proxy({}, {
        get: (_t, key: string) => (key in constants ? constants[key] : objects.has(key) ? () => ({ id: ++n }) : () => undefined),
    });
    setGLContext(gl as any);
    setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
    const lib = (await readExample('applications/editor/public/examples/dungeon')).read('libraries', 'models.json');
    const find = (node: any): any => node.model?.skin ? node : (node.children ?? []).map(find).find(Boolean);
    modelJson = find(lib[0].nodeJson).model;
});

function mannequin(): ModelNode {
    const node = new ModelNode('Mannequin', AnimatedModel.parse(JSON.parse(JSON.stringify(modelJson))));
    node.scene = {} as any;
    return node;
}

function expectSame(actual: ScenarioBTrace, expected: ScenarioBTrace): void {
    expect(actual.events).toEqual(expected.events);
    expect(actual.foliage).toEqual(expected.foliage);
    expect(actual.states.length).toBe(expected.states.length);
    for (let i = 0; i < expected.states.length; i++) expect(actual.states[i], `states, frame ${i * 10}`).toEqual(expected.states[i]);
    for (let i = 0; i < expected.queries.length; i++) expect(actual.queries[i], `queries, frame ${i * 10}`).toEqual(expected.queries[i]);
}

describe('physics scene B', () => {
    it('matches the recorded traces exactly, at a steady rate and on uneven frames', () => {
        const steady = runScenarioB(scenarioBPhysics(), mannequin);
        const uneven = runScenarioB(scenarioBPhysics(), mannequin, 200, UNEVEN);
        const traces = JSON.parse(JSON.stringify({ steady, uneven }));
        if (!existsSync(FIXTURE)) {
            mkdirSync(join(__dirname, 'fixtures'), { recursive: true });
            writeFileSync(FIXTURE, JSON.stringify(traces));
            throw new Error('Recorded a new golden trace; re-run to check against it.');
        }
        const golden = JSON.parse(readFileSync(FIXTURE, 'utf8'));
        expectSame(traces.steady, golden.steady);
        expectSame(traces.uneven, golden.uneven);
    });

    it('exercises what it claims to', () => {
        const t = runScenarioB(scenarioBPhysics(), mannequin);
        // The blade's swept contact, both ways, with a point and a fraction inside the frame.
        expect(t.events.some(e => /^Hurt enter Blade [-\d.e,]+ 0\.\d+/.test(e))).toBe(true);
        expect(t.events.some(e => /^Blade enter Hurt /.test(e))).toBe(true);
        expect(t.events).toContain('Zone enter Ball null 1');
        expect(t.events).toContain('Zone exit Ball null 1');
        expect(t.events.some(e => e.startsWith('Offset hit '))).toBe(true);
        // The pool filled, emptied, and filled again.
        expect(t.foliage[30]).toBeGreaterThan(0);
        expect(t.foliage[90]).toBe(0);
        expect(t.foliage[150]).toBe(t.foliage[30]);
        // The ragdoll was in the trace: rows grew while it lived.
        expect(t.states[3].length).toBeGreaterThan(t.states[0].length);
        // The floater floats.
        const floaterY = t.states[19][3 * 13 + 1];
        expect(floaterY).toBeGreaterThan(-0.6);
        expect(floaterY).toBeLessThan(0.4);
    });

    it('steps the same through the worker as inline', () => {
        const inline = runScenarioB(scenarioBPhysics(), mannequin);
        const p = scenarioBPhysics();
        p.setWorkerMode('on', () => new LoopbackPort());
        expect(p.executor).toBe('worker');
        const worker = runScenarioB(p, mannequin, 200, [1 / 60], 1);
        expect(p.executor).toBe('worker');
        expectSame(JSON.parse(JSON.stringify(worker)), JSON.parse(JSON.stringify(inline)));
    });
});
