import { describe, it, expect } from 'vitest';
import { Body, Box, Vec3 } from 'cannon-es';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { WaterVolumeNode, WATER_RIPPLE_SLOTS } from '../src/core/scene/nodes/waterVolumeNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { PhysicsSystem } from '../src/physics/physicsSystem';

// The WaterVolume node: its data, the physics step that buoys through it, and the surface effects it feeds
// a water material (ripple slots) — the last only when the material asks for them by name.

describe('WaterVolumeNode', () => {
    it('round-trips and the scene finds it', async () => {
        const scene = new Scene();
        const water = new WaterVolumeNode('pond', {
            size: [20, 2, 16], density: 1025, linearDrag: 3, angularDrag: 2, waveAmplitude: 0.05,
            waveFrequency: 0.4, affectCharacters: true, surfaceNodeId: 'abc', splashTemplate: 'Water Splash',
        });
        scene.addNode(water);
        expect([...scene.waterVolumes]).toEqual([water]);
        const json = JSON.parse(JSON.stringify(await water.serialize()));
        const parent = new Node('p');
        parseNodeJson(parent, json);
        const back = parent.children[0] as WaterVolumeNode;
        expect(back).toBeInstanceOf(WaterVolumeNode);
        expect([back.size, back.density, back.linearDrag, back.angularDrag, back.waveAmplitude, back.waveFrequency,
                back.affectCharacters, back.surfaceNodeId, back.splashTemplate])
            .toEqual([[20, 2, 16], 1025, 3, 2, 0.05, 0.4, true, 'abc', 'Water Splash']);
    });

    it('puts its surface on the top face, and measures depth below it', () => {
        const w = new WaterVolumeNode('w', { size: [10, 2, 10], waveAmplitude: 0 });
        w.setPosition([5, 1, 0]);
        w.updateTransforms?.();
        const box = w.worldBox();
        expect(box.max[1]).toBeCloseTo(2, 6);
        expect(box.min[1]).toBeCloseTo(0, 6);
        expect(w.surfaceHeightAt(5, 0, 3)).toBeCloseTo(2, 6);
        expect(w.depthAt([5, 1.5, 0])).toBeCloseTo(0.5, 6);
        expect(w.depthAt([50, 1.5, 0])).toBe(-Infinity);
        expect(w.contains([5, 1.5, 0])).toBe(true);
        expect(w.contains([5, 2.5, 0])).toBe(false);
    });

    it('waves the surface within its amplitude', () => {
        const w = new WaterVolumeNode('w', { size: [10, 2, 10], waveAmplitude: 0.1, waveFrequency: 1 });
        const heights = [0, 0.1, 0.2, 0.3].map(t => w.surfaceHeightAt(0, 0, t));
        expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.05);
        for (const h of heights) expect(Math.abs(h - 1)).toBeLessThanOrEqual(0.1 + 1e-9);
    });

    it('buoys bodies through the physics step, and leaves character bodies alone', () => {
        const water = new WaterVolumeNode('w', { size: [40, 4, 40], waveAmplitude: 0 });
        water.setPosition([0, -2, 0]);   // surface at y = 0
        water.updateTransforms?.();
        const p = new PhysicsSystem({ gravity: [0, -9.81, 0] });
        p.initialize();
        (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null, waterVolumes: new Set([water]) };

        const crate = new Body({ mass: 250, position: new Vec3(0, 0.5, 0) });   // 1 m³ at 250 kg/m³
        crate.addShape(new Box(new Vec3(0.5, 0.5, 0.5)));
        p.addBody(crate);
        const character = new Body({ mass: 70, position: new Vec3(5, -1, 0) });
        character.addShape(new Box(new Vec3(0.3, 0.9, 0.3)));
        (character as any).owner = { nodeType: 'character' };
        p.addBody(character);

        for (let i = 0; i < 600; i++) p.update(1 / 60);
        // Floats with a quarter of its volume under: the centre ~0.25 m above the surface.
        expect(crate.position.y).toBeGreaterThan(0.1);
        expect(crate.position.y).toBeLessThan(0.45);
        // The character was never pushed up: it fell through the (floorless) water.
        expect(character.position.y).toBeLessThan(-20);
    });

    it('writes ripple slots into a surface material that declares them, and only that one', () => {
        const water = new WaterVolumeNode('w', { size: [20, 2, 20], waveAmplitude: 0, surfaceNodeId: 'surface' });
        water.setPosition([0, -1, 0]);   // surface at y = 0
        water.updateTransforms?.();
        const declared = { uniforms: [{ name: 'ripple0', type: 'vec4', value: [0, 0, -1000, 0] }], properties: new Map() };
        const other = { uniforms: [{ name: 'tint', type: 'vec3', value: [1, 1, 1] }], properties: new Map() };
        const wader = { worldPosition: [2, -0.5, 3], currentVelocity: [1.5, 0, 0] };
        (water as any)._scene = {
            characters: new Set([wader]),
            getNodeById: () => ({ model: { materials: [declared, other] } }),
            instantiate: () => null,
        };
        water.update(1 / 60, 0);
        const r0 = declared.properties.get('ripple0');
        expect(r0[0]).toBeCloseTo(2, 6);
        expect(r0[1]).toBeCloseTo(3, 6);
        expect(r0[3]).toBeGreaterThan(0);
        for (let i = 0; i < WATER_RIPPLE_SLOTS; i++) expect(declared.properties.has(`ripple${i}`)).toBe(true);
        expect(other.properties.size).toBe(0);
    });
});
