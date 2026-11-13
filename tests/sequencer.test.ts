import { describe, it, expect } from 'vitest';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { Camera } from '../src/core/camera';
import { CameraNode } from '../src/core/scene/nodes/cameraNode';
import { SequenceNode, resolveNodePath } from '../src/core/scene/nodes/sequenceNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { regenerateNodeIds } from '../src/core/scene/nodeJson';
import { evaluateKeyedNumber, evaluateKeyedStep, evaluateKeyedVector, rampWeight, Spline3 } from '../src/core/math';
import { parseSequence } from '../src/sequencer/parse';
import { compilePropertyPath } from '../src/sequencer/propertyPath';
import type { SequenceData } from '../src/sequencer/types';

const DT = 1 / 60;

function sequence(partial: Partial<SequenceData>): SequenceData {
    return parseSequence({ version: 1, name: 'Test', duration: 10, fps: 30, clock: 'game', loop: false,
                           slots: [], tracks: [], markers: [], ...partial });
}

function run(scene: Scene, seconds: number): void {
    const frames = Math.round(seconds / DT);
    for (let i = 0; i < frames; i++) scene.update(DT, 0, false);
}

describe('sequence curves', () => {
    it('interpolates linear, constant and stepped keys', () => {
        const linear = { keys: [{ t: 0, v: 0, interp: 'linear' as const }, { t: 2, v: 10 }] };
        expect(evaluateKeyedNumber(linear, 1)).toBeCloseTo(5);
        expect(evaluateKeyedNumber(linear, -1)).toBe(0);
        expect(evaluateKeyedNumber(linear, 5)).toBe(10);
        const constant = { keys: [{ t: 0, v: 1, interp: 'constant' as const }, { t: 1, v: 2 }] };
        expect(evaluateKeyedNumber(constant, 0.99)).toBe(1);
        expect(evaluateKeyedNumber(constant, 1)).toBe(2);
        const words = { keys: [{ t: 0, v: 'a' }, { t: 1, v: 'b' }] };
        expect(evaluateKeyedStep(words, 0.5, '')).toBe('a');
        expect(evaluateKeyedStep(words, 1.5, '')).toBe('b');
    });

    it('never overshoots with auto keys', () => {
        // A progress curve that dwells, then goes: plain Catmull-Rom would dip below 0.5 and run backwards.
        const curve = { keys: [{ t: 0, v: 0 }, { t: 1, v: 0.5 }, { t: 1.1, v: 0.5 }, { t: 4, v: 1 }] };
        let last = -Infinity;
        for (let t = 0; t <= 4; t += 0.01) {
            const v = evaluateKeyedNumber(curve, t);
            expect(v).toBeGreaterThanOrEqual(last - 1e-9);
            expect(v).toBeGreaterThanOrEqual(-1e-9);
            expect(v).toBeLessThanOrEqual(1 + 1e-9);
            last = v;
        }
    });

    it('evaluates vectors component-wise', () => {
        const curve = { keys: [{ t: 0, v: [0, 10, 20], interp: 'linear' as const }, { t: 1, v: [1, 11, 21] }] };
        expect(evaluateKeyedVector(curve, 0.5, [0, 0, 0])).toEqual([0.5, 10.5, 20.5]);
    });

    it('weights a section by its eases', () => {
        expect(rampWeight(0, 10, 2, 2, 0)).toBe(0);
        expect(rampWeight(0, 10, 2, 2, 1)).toBeCloseTo(0.5);
        expect(rampWeight(0, 10, 2, 2, 5)).toBe(1);
        expect(rampWeight(0, 10, 2, 2, 10)).toBe(0);
        expect(rampWeight(0, 10, undefined, undefined, 0)).toBe(1);
    });
});

describe('Spline3', () => {
    it('passes through its control points and moves at constant speed', () => {
        // Unevenly spaced points: the case where uniform parameterisation surges.
        const spline = new Spline3([[0, 0, 0], [1, 0, 0], [10, 0, 2], [11, 0, 30]]);
        expect(spline.pointAt(0)).toEqual([0, 0, 0]);
        const end = spline.pointAt(1);
        expect(end[0]).toBeCloseTo(11, 6); expect(end[2]).toBeCloseTo(30, 6);
        const steps = 50, gaps: number[] = [];
        let prev = spline.pointAt(0);
        for (let i = 1; i <= steps; i++) {
            const p = spline.pointAt(i / steps);
            gaps.push(Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]));
            prev = p;
        }
        const mean = gaps.reduce((a, b) => a + b) / gaps.length;
        for (const g of gaps) expect(Math.abs(g - mean) / mean).toBeLessThan(0.02);
        const sum = gaps.reduce((a, b) => a + b);
        expect(Math.abs(sum - spline.length) / spline.length).toBeLessThan(0.01);
    });

    it('reports the direction of travel', () => {
        const spline = new Spline3([[0, 0, 0], [0, 0, 10]]);
        const t = spline.tangentAt(0.5);
        expect(t[2]).toBeCloseTo(1, 5);
    });
});

describe('parseSequence', () => {
    it('drops malformed tracks and sorts what it keeps', () => {
        const seq = parseSequence({
            name: 'S', duration: 5,
            tracks: [
                { id: 'a', type: 'property', slot: 's', path: 'x', valueType: 'number',
                  sections: [{ id: 'p', start: 2, end: 1, curve: { keys: [{ t: 1, v: 2 }, { t: 0, v: 1 }] } }] },
                { id: 'b', type: 'nonsense' },
                { id: 'c', type: 'path', sections: [] },
                { id: 'd', type: 'event', keys: [{ t: 3, method: 'b' }, { t: 1, method: 'a' }, { t: 2 }] },
            ],
        });
        expect(seq.tracks.map(t => t.id)).toEqual(['a', 'd']);
        const prop = seq.tracks[0] as any;
        expect(prop.sections[0].end).toBe(2);
        expect(prop.sections[0].curve.keys.map((k: any) => k.t)).toEqual([0, 1]);
        expect((seq.tracks[1] as any).keys.map((k: any) => k.method)).toEqual(['a', 'b']);
    });
});

describe('compilePropertyPath', () => {
    it('reads and writes nested fields, maps and transforms', () => {
        const node = new Node('n');
        (node as any).hour = 9;
        (node as any).bag = { inner: { value: 1 }, props: new Map<string, unknown>([['waves', 0.3]]) };
        const hour = compilePropertyPath(node, 'hour');
        expect(hour.get()).toBe(9);
        expect(hour.set(12)).toBe(true);
        expect((node as any).hour).toBe(12);
        const inner = compilePropertyPath(node, 'bag.inner.value');
        inner.set(5);
        expect((node as any).bag.inner.value).toBe(5);
        compilePropertyPath(node, 'bag.props.waves').set(0.1);
        expect((node as any).bag.props.get('waves')).toBe(0.1);
        compilePropertyPath(node, 'position').set([1, 2, 3]);
        expect(Array.from(node.position)).toEqual([1, 2, 3]);
        expect(compilePropertyPath(node, 'missing.path').set(1)).toBe(false);
        expect(compilePropertyPath(node, '_private').get()).toBeUndefined();
    });
});

function cameraScene(seq: Partial<SequenceData>, bindCamera = true) {
    const scene = new Scene();
    const gameplay = new CameraNode('Gameplay Camera', new Camera({}));
    const cine = new CameraNode('Cinematic Camera', new Camera({}));
    cine.active = false;
    const director = new SequenceNode('Tour', {
        sequence: sequence({ slots: [{ id: 'cam', name: 'Camera', nodeType: 'camera' }], ...seq }),
        bindings: bindCamera ? { cam: cine.id } : {},
    });
    scene.addNode(gameplay);
    scene.addNode(cine);
    scene.addNode(director);
    scene.start();
    return { scene, gameplay, cine, director };
}

describe('SequenceNode', () => {
    const tour = {
        tracks: [
            { id: 'path', type: 'path', slot: 'cam',
              sections: [{ id: 's1', start: 0, end: 10, points: [[0, 2, 0], [0, 2, 100]], look: { mode: 'ahead', distance: 5 } }] },
            { id: 'cut', type: 'cameraCut', sections: [{ id: 'c1', start: 0, end: 10, slot: 'cam' }] },
        ],
    } as any;

    it('moves its camera the same frame and pins it through the cut', () => {
        const { scene, gameplay, cine, director } = cameraScene(tour);
        expect(scene.activeCamera).toBe(gameplay);
        director.play();
        // play() evaluates at once: the first frame is already the shot.
        expect(scene.activeCamera).toBe(cine);
        expect(cine.active).toBe(true);
        run(scene, 5);
        expect(director.time).toBeCloseTo(5, 5);
        // Halfway along a straight 100 m path at constant speed, and the world matrix is current.
        expect(cine.worldPosition[2]).toBeCloseTo(50, 0);
        expect(cine.worldPosition[1]).toBeCloseTo(2, 5);
        // Looking ahead along +Z.
        expect(cine.worldForward[2]).toBeGreaterThan(0.99);
    });

    it('only reports the shot while previewCuts is off (the editor keeps its viewport camera)', () => {
        const { scene, gameplay, cine, director } = cameraScene(tour);
        scene.setActiveCamera(gameplay);
        director.previewCuts = false;
        director.seek(5);
        expect(director.shotCamera).toBe(cine);
        expect(scene.pinnedCamera).toBe(gameplay);
        expect(cine.active).toBe(false);
        // The path still moves the camera: a preview can look through it.
        expect(cine.worldPosition[2]).toBeCloseTo(50, 0);
        director.stop();
        expect(director.shotCamera).toBe(null);
        expect(scene.pinnedCamera).toBe(gameplay);
    });

    it('serializes a copy of its sequence, never the live object', async () => {
        const { director } = cameraScene(tour);
        const json = await director.serialize();
        expect(json.sequence).toEqual(director.sequence);
        expect(json.sequence).not.toBe(director.sequence);
        expect(json.sequence.tracks[0]).not.toBe(director.sequence.tracks[0]);
    });

    it('stop() restores the camera, its flag and the pin', () => {
        const { scene, gameplay, cine, director } = cameraScene(tour);
        cine.setPosition([7, 8, 9]);
        director.play();
        run(scene, 2);
        director.stop();
        expect(Array.from(cine.position)).toEqual([7, 8, 9]);
        expect(cine.active).toBe(false);
        expect(scene.pinnedCamera).toBe(null);
        expect(scene.activeCamera).toBe(gameplay);
        expect(director.isPlaying).toBe(false);
    });

    it('finishes, resolves `finished` and keeps the last shot until stopped', async () => {
        const { scene, cine, director } = cameraScene({ ...tour, duration: 1,
            tracks: tour.tracks.map((t: any) => ({ ...t, sections: t.sections.map((s: any) => ({ ...s, end: 1 })) })) });
        const reasons: string[] = [];
        director.onFinished(r => reasons.push(r));
        director.play();
        run(scene, 1.5);
        expect(director.isPlaying).toBe(false);
        await expect(director.finished).resolves.toBe('finished');
        expect(reasons).toEqual(['finished']);
        // A cut ends by restoring (the default for the camera cut), a path holds its end.
        expect(cine.active).toBe(false);
        expect(cine.worldPosition[2]).toBeCloseTo(100, 3);
    });

    it('finds a slot by its path when the slot is unbound', () => {
        const { scene, cine, director } = cameraScene({
            ...tour, slots: [{ id: 'cam', name: 'Camera', path: 'Cinematic Camera' }],
        }, false);
        director.play();
        run(scene, 1);
        expect(scene.activeCamera).toBe(cine);
        expect(resolveNodePath(scene.root, 'Cinematic Camera')).toBe(cine);
    });

    it('drives a property, blending in from its value and restoring it', () => {
        const scene = new Scene();
        const clock = new Node('Time of Day');
        (clock as any).hour = 9;
        const director = new SequenceNode('Seq', { sequence: sequence({
            slots: [{ id: 'tod', name: 'Time of Day' }],
            tracks: [{ id: 'h', type: 'property', slot: 'tod', path: 'hour', valueType: 'number',
                       sections: [{ id: 'p', start: 1, end: 5, easeIn: 2,
                                    curve: { keys: [{ t: 0, v: 15, interp: 'linear' }, { t: 4, v: 15 }] } }] }],
        } as any), bindings: { tod: clock.id } });
        scene.addNode(clock);
        scene.addNode(director);
        scene.start();
        director.play();
        expect((clock as any).hour).toBe(9);        // before the section: untouched
        run(scene, 2);                               // halfway through the ease-in
        expect((clock as any).hour).toBeCloseTo(12, 0);
        run(scene, 2);
        expect((clock as any).hour).toBeCloseTo(15, 5);
        // Something else changes it after the section has ended: the sequence leaves it alone.
        run(scene, 2);
        (clock as any).hour = 20;
        run(scene, 1);
        expect((clock as any).hour).toBe(20);
        director.stop();
        expect((clock as any).hour).toBe(9);
    });

    it("restores at a section's end when told to", () => {
        const scene = new Scene();
        const target = new Node('T');
        (target as any).level = 1;
        const director = new SequenceNode('Seq', { sequence: sequence({
            slots: [{ id: 't', name: 'T' }],
            tracks: [{ id: 'p', type: 'property', slot: 't', path: 'level', valueType: 'number',
                       sections: [{ id: 's', start: 0, end: 1, whenFinished: 'restore', curve: { keys: [{ t: 0, v: 5 }] } }] }],
        } as any), bindings: { t: target.id } });
        scene.addNode(target);
        scene.addNode(director);
        scene.start();
        director.play();
        run(scene, 0.5);
        expect((target as any).level).toBe(5);
        run(scene, 1);
        expect((target as any).level).toBe(1);
    });

    it('fires events in (previous, current], at the start, never on a seek, once per loop', () => {
        const scene = new Scene();
        const calls: string[] = [];
        const director = new SequenceNode('Seq', { sequence: sequence({
            duration: 2, loop: true,
            tracks: [{ id: 'e', type: 'event', keys: [{ t: 0, method: 'begin' }, { t: 1, method: 'middle' }, { t: 2, name: 'end' }] }],
        } as any) });
        (director as any).begin = () => calls.push('begin');
        (director as any).middle = () => calls.push('middle');
        director.onEvent(name => { if (name === 'end') calls.push('end'); });
        scene.addNode(director);
        scene.start();
        director.seek(1.5);
        expect(calls).toEqual([]);
        director.play();
        expect(calls).toEqual(['begin']);
        run(scene, 4.05);
        expect(calls).toEqual(['begin', 'middle', 'end', 'begin', 'middle', 'end', 'begin']);
    });

    it('does not advance while the scene is paused, and pauses on request', () => {
        const { scene, director } = cameraScene(tour);
        director.play();
        for (let i = 0; i < 30; i++) scene.update(DT, 0, true);
        expect(director.time).toBe(0);
        director.pause();
        run(scene, 1);
        expect(director.time).toBe(0);
        director.resume();
        run(scene, 1);
        expect(director.time).toBeCloseTo(1, 5);
    });

    it('round-trips through JSON, and a copy drives the copies of its actors', async () => {
        const { scene, cine, director } = cameraScene(tour);
        const json = await director.serialize();
        expect(json.type).toBe('sequence');
        expect(json.bindings).toEqual({ cam: cine.id });
        const host = new Node('host');
        scene.addNode(host);
        parseNodeJson(host, json);
        const parsed = host.children[0] as SequenceNode;
        expect(parsed).toBeInstanceOf(SequenceNode);
        expect(parsed.sequence.tracks.length).toBe(2);

        // Copy a subtree holding both the camera and the sequence: the copy's binding follows the copy.
        const cameraJson = await cine.serialize();
        const tree = { id: 'group', name: 'Group', type: 'node', children: [cameraJson, json] };
        const map = new Map<string, string>();
        regenerateNodeIds(tree, map);
        expect((tree.children[1] as any).bindings.cam).toBe(map.get(cine.id));
        expect((tree.children[1] as any).bindings.cam).not.toBe(cine.id);
    });
});
