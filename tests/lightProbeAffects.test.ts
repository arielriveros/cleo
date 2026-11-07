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
    probe.setBakedMaps(fakeCube());
    probe.reflectionLayer = 0;
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
});

describe('light probe volumes', () => {
    it('measures the distance to the volume, not to its centre', () => {
        const at = (probe: LightProbeNode, x: number) => { probe.setPosition(vec3.fromValues(x, 0, 0)); probe.updateTransforms(); return probe; };
        const wide = at(bakedProbe('wide', { size: [100, 10, 10] }), 52);
        const small = at(bakedProbe('small', { size: [2, 2, 2] }), -9);
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
