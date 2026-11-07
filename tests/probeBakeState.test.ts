import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { LightNode } from '../src/core/scene/nodes/lightNode';
import { LightProbeNode } from '../src/core/scene/nodes/lightProbeNode';
import { Node } from '../src/core/scene/nodes/node';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { DirectionalLight, PointLight, Spotlight } from '../src/graphics/lighting';
import { describeLightChanges, lightBakeChanges, lightLabel, lightReachesProbe, probeBakeStaleness } from '../src/core/scene/probeBakeState';
import { bakedLightSnapshots } from '../src/graphics/render/probeBaker';
import { Scene } from '../src/core/scene/scene';

const at = <T extends { setPosition(v: vec3): void; updateTransforms(): void }>(n: T, x: number, y = 0, z = 0) => {
    n.setPosition(vec3.fromValues(x, y, z)); n.updateTransforms(); return n;
};

function setup() {
    const scene = new Scene();
    const torch = at(new LightNode('Torch', new PointLight({ intensity: 800, range: 8 })), 2, 1, 0);
    const sun = new LightNode('Sun', new DirectionalLight({ intensity: 50000 }), true);
    const faraway = at(new LightNode('Far lamp', new PointLight({ intensity: 800, range: 5 })), 900, 0, 0);
    const probe = at(new LightProbeNode('Room', { size: [10, 4, 10] }), 0, 0, 0);
    for (const n of [torch, sun, faraway, probe]) scene.addNode(n);
    // As a finished bake leaves it: the request taken, the lights it saw recorded.
    probe.takeBakeRequests();
    probe.markBaked(0);
    probe.bakedLights = bakedLightSnapshots(scene, probe);
    return { scene, torch, sun, faraway, probe };
}

describe('lights set to bake', () => {
    it('bake by default, and keep the flag through a save', async () => {
        const light = new LightNode('Lamp', new Spotlight({}));
        expect(light.bake).toBe(true);
        light.bake = false;
        const parent = new Node('parent');
        parseNodeJson(parent, await light.serialize());
        expect((parent.children[0] as LightNode).bake).toBe(false);
    });

    it('read a light saved before the flag as baked', async () => {
        const json = await new LightNode('Old', new PointLight({})).serialize();
        delete json.bake;
        const parent = new Node('parent');
        parseNodeJson(parent, json);
        expect((parent.children[0] as LightNode).bake).toBe(true);
    });

    it('count for a probe only when they can reach it, a sun always', () => {
        const { torch, sun, faraway, probe } = setup();
        expect(lightReachesProbe(torch, probe)).toBe(true);
        expect(lightReachesProbe(sun, probe)).toBe(true);
        expect(lightReachesProbe(faraway, probe)).toBe(false);
        expect([...probe.bakedLights!.keys()].sort()).toEqual([sun.id, torch.id].sort());
    });
});

describe('a baked probe out of date with its lights (probeBakeStaleness)', () => {
    it('is current right after its bake', () => {
        const { scene, probe } = setup();
        expect(probeBakeStaleness([probe], scene.lights)).toEqual([]);
    });

    it('names what changed: moved, colour, intensity, cone', () => {
        const { scene, torch, probe } = setup();
        at(torch, 3, 1, 0);
        (torch.light as PointLight).color = [1, 0.5, 0.2];
        (torch.light as PointLight).intensity = 1200;
        const stale = probeBakeStaleness([probe], scene.lights);
        expect(stale).toHaveLength(1);
        expect(stale[0].lights[0].what).toEqual(['moved', 'colour', 'intensity']);
        expect(describeLightChanges(stale[0].lights[0].what)).toBe('moved, colour changed and intensity changed');
    });

    it('takes a sun by where it points, not where its node stands', () => {
        const { scene, sun, probe } = setup();
        at(sun, 50, 0, 0);
        expect(probeBakeStaleness([probe], scene.lights)).toEqual([]);
        sun.setRotation(vec3.fromValues(-40, 30, 0)); sun.updateTransforms();
        expect(probeBakeStaleness([probe], scene.lights)[0].lights[0].what).toEqual(['turned']);
    });

    it('notices a light set not to bake, removed, or a new one in reach', () => {
        const { scene, torch, probe } = setup();
        torch.bake = false;
        expect(probeBakeStaleness([probe], scene.lights)[0].lights[0].what).toEqual(['removed']);
        torch.bake = true;
        const lamp = at(new LightNode('New lamp', new PointLight({ range: 6 })), -2, 1, 0);
        scene.addNode(lamp);
        const stale = probeBakeStaleness([probe], scene.lights);
        expect(stale[0].lights.map(l => [l.name, l.what])).toEqual([['New lamp', ['added']]]);
    });

    it('ignores what does not matter: a far light, a flicker, a realtime probe, a probe already asked for', () => {
        const { scene, torch, faraway, probe } = setup();
        at(faraway, 905, 0, 0);
        (torch.light as PointLight).flickerAmount = 0.3;    // the flicker is live, never baked
        expect(probeBakeStaleness([probe], scene.lights)).toEqual([]);
        at(torch, 4, 1, 0);
        probe.relight();
        expect(probeBakeStaleness([probe], scene.lights)).toEqual([]);
        probe.takeBakeRequests();
        probe.mode = 'realtime';
        expect(probeBakeStaleness([probe], scene.lights)).toEqual([]);
    });

    it('labels a generic light by the prop it belongs to', () => {
        const torchProp = new Node('Torch 3');
        const light = new LightNode('Light', new PointLight({}));
        const root = new Node('root');
        root.addChild(torchProp);
        torchProp.addChild(light);
        expect(lightLabel(light)).toBe('Torch 3 › Light');
        expect(lightBakeChanges(light.bakeSnapshot(), light.bakeSnapshot())).toEqual([]);
    });
});
