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
