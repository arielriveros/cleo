import { describe, expect, it } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { LightNode } from '../src/core/scene/nodes/lightNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { lightBakeChanges } from '../src/core/scene/probeBakeState';
import { AreaLight, LIGHT_UNIT } from '../src/graphics/lighting';
import { AREA_LIGHT_PRESETS, lightPresetsFor, newLightOptions } from '../src/graphics/lightPresets';
import { Scene } from '../src/core/scene/scene';

describe('area light nodes', () => {
    it('round-trips through the scene JSON', async () => {
        const light = new AreaLight({ unit: LIGHT_UNIT, intensity: 3600, range: 9, shape: 'disk', width: 0.6, twoSided: true,
                                      color: [1, 0.9, 0.8], flicker: { amount: 0.2, speed: 5 } });
        const node = new LightNode('panel', light, true);
        node.bake = false;
        const json = await node.serialize();
        expect(json.lightType).toBe('area');
        const parent = new Node('parent');
        parseNodeJson(parent, json);
        const back = parent.children[0] as LightNode;
        expect(back.type).toBe('area');
        const a = back.light as AreaLight;
        expect(a).toBeInstanceOf(AreaLight);
        expect(a.intensity).toBe(3600);
        expect(a.range).toBe(9);
        expect(a.shape).toBe('disk');
        expect(a.width).toBeCloseTo(0.6);
        expect(a.height).toBeCloseTo(0.6);
        expect(a.twoSided).toBe(true);
        expect(a.flickerAmount).toBeCloseTo(0.2);
        expect([...a.color].map(c => +c.toFixed(5))).toEqual([1, 0.9, 0.8]);
        expect(back.castShadows).toBe(true);
        expect(back.bake).toBe(false);
    });

    it('is numbered with the point and spot lights, and counted', () => {
        const scene = new Scene();
        scene.addNode(new LightNode('a', new AreaLight({ unit: LIGHT_UNIT })));
        scene.addNode(new LightNode('b', new AreaLight({ unit: LIGHT_UNIT, twoSided: true })));
        (scene as any)._asignLightIndices();   // what a frame's update does first
        const lights = [...scene.lights];
        expect(lights.map(l => l.index).sort()).toEqual([0, 1]);
        expect(scene.numAreaLights).toBe(2);
        expect(scene.numLights).toBe(2);
    });

    it('tells a probe bake it is stale when it is resized or reshaped', () => {
        const node = new LightNode('panel', new AreaLight({ unit: LIGHT_UNIT }));
        const then = node.bakeSnapshot();
        expect(then.area).toEqual({ shape: 'rect', width: 1, height: 0.5, twoSided: false });
        expect(lightBakeChanges(then, node.bakeSnapshot())).toEqual([]);
        (node.light as AreaLight).width = 2;
        expect(lightBakeChanges(then, node.bakeSnapshot())).toContain('size');
        (node.light as AreaLight).width = 1;
        (node.light as AreaLight).twoSided = true;
        expect(lightBakeChanges(then, node.bakeSnapshot())).toContain('size');
    });

    it('has presets of its own and a ceiling-panel default', () => {
        expect(lightPresetsFor(new AreaLight({ unit: LIGHT_UNIT }))).toBe(AREA_LIGHT_PRESETS);
        const opts = newLightOptions('area');
        expect(opts.shape).toBe('rect');
        const made = new AreaLight({ unit: LIGHT_UNIT, ...opts });
        expect(made.width).toBe(1);
        expect(made.height).toBe(0.5);
        for (const p of AREA_LIGHT_PRESETS) expect(p.options.intensity).toBeGreaterThan(0);
    });
});
