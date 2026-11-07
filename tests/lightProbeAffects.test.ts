import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { LightProbeNode } from '../src/core/scene/nodes/lightProbeNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import type { Texture } from '../src/graphics/texture';

/** Stand-in baked maps: selection only asks whether a probe has them. No GL context here. */
const fakeCube = () => ({ delete() {} }) as unknown as Texture;
function bakedProbe(name: string, options: ConstructorParameters<typeof LightProbeNode>[1] = {}): LightProbeNode {
    const probe = new LightProbeNode(name, options);
    probe.setBakedMaps(fakeCube(), fakeCube(), fakeCube());
    return probe;
}

describe('light probe lobes: lighting and reflections', () => {
    it('affects both by default', () => {
        const probe = new LightProbeNode('probe');
        expect(probe.affectsLighting).toBe(true);
        expect(probe.affectsReflections).toBe(true);
    });

    it('round-trips the choice', async () => {
        const probe = new LightProbeNode('probe', { size: [4, 4, 4] });
        probe.affectsLighting = false;
        const parent = new Node('parent');
        parseNodeJson(parent, await probe.serialize());
        const restored = parent.children[0] as LightProbeNode;
        expect(restored.affectsLighting).toBe(false);
        expect(restored.affectsReflections).toBe(true);
    });

    it('reads a probe saved before the setting existed as affecting both', async () => {
        const json = await new LightProbeNode('old').serialize();
        delete json.affectsLighting;
        delete json.affectsReflections;
        const parent = new Node('parent');
        parseNodeJson(parent, json);
        const restored = parent.children[0] as LightProbeNode;
        expect(restored.affectsLighting).toBe(true);
        expect(restored.affectsReflections).toBe(true);
    });

    it('gives the forward path reflections only from probes that give them', () => {
        const scene = new Scene();
        const near = bakedProbe('near', { size: [10, 10, 10] });
        const outer = bakedProbe('outer');               // unbounded: the fallback everywhere
        near.affectsReflections = false;
        scene.addNode(near);
        scene.addNode(outer);
        const p = vec3.fromValues(0, 0, 0);
        // Any purpose: the volume that contains the point wins.
        expect(scene.probeForPoint(p)).toBe(near);
        // Reflections: the lighting-only probe steps aside for the next one that reflects.
        expect(scene.probeForPoint(p, true)).toBe(outer);
    });

    it('does not give a deferred slot to a probe that contributes nothing', () => {
        const scene = new Scene();
        const idle = bakedProbe('idle', { size: [10, 10, 10], affectsLighting: false, affectsReflections: false });
        const reflective = bakedProbe('reflective', { size: [10, 10, 10], affectsLighting: false });
        scene.addNode(idle);
        scene.addNode(reflective);
        expect(scene.probesForFrame(vec3.fromValues(0, 0, 0), 2)).toEqual([reflective]);
    });
});

describe('deferred probe slots (Scene.probesForFrame)', () => {
    const at = (probe: LightProbeNode, x: number, y: number, z: number) => { probe.setPosition(vec3.fromValues(x, y, z)); probe.updateTransforms(); return probe; };

    it('always keeps the last slot for the unbounded fallback, however many volumes are near', () => {
        const scene = new Scene();
        const a = at(bakedProbe('a', { size: [10, 10, 10] }), 0, 0, 0);
        const b = at(bakedProbe('b', { size: [10, 10, 10] }), 12, 0, 0);
        const global = at(bakedProbe('global'), 300, 0, 0);
        for (const p of [a, b, global]) scene.addNode(p);
        expect(scene.probesForFrame(vec3.fromValues(1, 0, 0), 2)).toEqual([a, global]);
        // Without a fallback, both slots go to volumes.
        scene.removeNode(global);
        expect(scene.probesForFrame(vec3.fromValues(1, 0, 0), 2)).toEqual([a, b]);
    });

    it('puts the smallest volume CONTAINING the camera first: a room inside the hamlet', () => {
        const scene = new Scene();
        const hamlet = at(bakedProbe('hamlet', { size: [100, 30, 70] }), 0, 0, 0);
        const room = at(bakedProbe('room', { size: [10, 5, 18] }), 30, 0, 10);
        const global = bakedProbe('global');
        for (const p of [hamlet, room, global]) scene.addNode(p);
        expect(scene.probesForFrame(vec3.fromValues(31, 1, 12), 2)).toEqual([room, global]);
        // Out in the hamlet, away from the room.
        expect(scene.probesForFrame(vec3.fromValues(-30, 1, 0), 2)).toEqual([hamlet, global]);
    });

    it('orders volumes the camera is outside of by the distance to the volume, not to its centre', () => {
        const scene = new Scene();
        // A wide box whose centre is far, but whose edge is 2 m off; a small box 8 m off.
        const wide = at(bakedProbe('wide', { size: [100, 10, 10] }), 52, 0, 0);
        const small = at(bakedProbe('small', { size: [2, 2, 2] }), -9, 0, 0);
        for (const p of [wide, small]) scene.addNode(p);
        expect(scene.probesForFrame(vec3.fromValues(0, 0, 0), 1)).toEqual([wide]);
        expect(wide.distanceToVolume(vec3.fromValues(0, 0, 0))).toBeCloseTo(2, 5);
        expect(small.distanceToVolume(vec3.fromValues(0, 0, 0))).toBeCloseTo(8, 5);
    });

    it('measures the distance in the box\'s own orientation', () => {
        const probe = bakedProbe('turned', { size: [10, 2, 2] });
        probe.setRotation(vec3.fromValues(0, 90, 0));
        probe.updateTransforms();
        // Turned 90 degrees, its long axis runs along Z.
        expect(probe.distanceToVolume(vec3.fromValues(0, 0, 4))).toBeCloseTo(0, 5);
        expect(probe.distanceToVolume(vec3.fromValues(4, 0, 0))).toBeCloseTo(3, 4);
    });
});

describe('probe bakes, one per frame (nextProbeToBake)', () => {
    it('takes one never-baked probe first, then one asked for, nearest the camera first, then realtime', async () => {
        const { nextProbeToBake } = await import('../src/graphics/render/sky');
        const place = (p: LightProbeNode, x: number) => { p.setPosition(vec3.fromValues(x, 0, 0)); p.updateTransforms(); return p; };
        const fresh = place(new LightProbeNode('fresh'), 100);
        const near = place(bakedProbe('near'), 5);
        const far = place(bakedProbe('far'), 50);
        const live = place(bakedProbe('live', { mode: 'realtime', updateFrequency: 0 }), 1);
        // Baked once already; then the near and far ones are asked for again (a time-of-day re-bake).
        for (const p of [near, far, live]) p.markBaked(0);
        near.bake(); far.bake();
        const cam = [0, 0, 0];
        const all = [far, live, near, fresh];
        expect(nextProbeToBake(all, cam, 1000)).toBe(fresh);
        fresh.setBakedMaps(fakeCube(), fakeCube(), fakeCube()); fresh.markBaked(1000);
        expect(nextProbeToBake(all, cam, 1000)).toBe(near);
        near.markBaked(1000);
        expect(nextProbeToBake(all, cam, 1000)).toBe(far);
        far.markBaked(1000);
        // Only the realtime refresh is left; once it is not due either, nothing is.
        expect(nextProbeToBake(all, cam, 1000)).toBe(live);
        const slow = place(bakedProbe('slow', { mode: 'realtime', updateFrequency: 5 }), 0);
        slow.markBaked(1000);
        expect(nextProbeToBake([slow], cam, 2000)).toBe(null);
        expect(nextProbeToBake([slow], cam, 6500)).toBe(slow);
    });
});
