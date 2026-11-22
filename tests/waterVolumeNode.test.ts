import { describe, it, expect } from 'vitest';
import { makeBody, box } from './helpers/physicsBodies';
import { Body, Box, Vec3 } from 'cannon-es';
import './helpers/features';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { WaterVolumeNode, WATER_RIPPLE_SLOTS } from '../src/core/scene/nodes/waterVolumeNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { TEST_PHYSICS } from './helpers/testPhysics';
import { authoring } from '../src/core/eventBus';
import { ALL_LAYERS, LAYER } from '../src/physics/collisionLayers';

// The WaterVolume node: its data, the physics step that buoys through it, and the surface effects it feeds
// a water material (ripple slots) — the last only when the material asks for them by name.

describe('WaterVolumeNode', () => {
    it('round-trips and the scene finds it', async () => {
        const scene = new Scene();
        const water = new WaterVolumeNode('pond', {
            size: [20, 2, 16], density: 1025, linearDrag: 3, angularDrag: 2, waveAmplitude: 0.05,
            waveFrequency: 0.4, affectCharacters: true, surfaceNodeId: 'abc', splashTemplate: 'Water Splash',
            wadeSplashTemplate: 'Water Step',
        });
        scene.addNode(water);
        expect([...scene.waterVolumes]).toEqual([water]);
        const json = JSON.parse(JSON.stringify(await water.serialize()));
        const parent = new Node('p');
        parseNodeJson(parent, json);
        const back = parent.children[0] as WaterVolumeNode;
        expect(back).toBeInstanceOf(WaterVolumeNode);
        expect([back.size, back.density, back.linearDrag, back.angularDrag, back.waveAmplitude, back.waveFrequency,
                back.affectCharacters, back.surfaceNodeId, back.splashTemplate, back.wadeSplashTemplate])
            .toEqual([[20, 2, 16], 1025, 3, 2, 0.05, 0.4, true, 'abc', 'Water Splash', 'Water Step']);
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
        const p = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: TEST_PHYSICS });
        p.initialize();
        (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null, waterVolumes: new Set([water]) };

        const crate = makeBody(box(0.5, 0.5, 0.5), { mass: 250, position: [0, 0.5, 0] });   // 1 m³ at 250 kg/m³
        p.addBody(crate);
        const character = makeBody(box(0.3, 0.9, 0.3), { mass: 70, position: [5, -1, 0], owner: { nodeType: 'character' } as any });
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

// What crosses the surface, for the live waves (render/waterWaves.ts): every physics body on a layer the water
// reacts to whose bounds cut the surface, with its motion against the water's.
describe('WaterVolumeNode disturbances', () => {
    /** A body as the physics hands it over: its box (half extents) round its position. */
    function body(at: number[], half: number[], options: { v?: number[]; layer?: number; dynamic?: boolean; trigger?: boolean; asleep?: boolean } = {}) {
        const position = { x: at[0], y: at[1], z: at[2] };
        const v = options.v ?? [0, 0, 0];
        return {
            position, velocity: { x: v[0], y: v[1], z: v[2] },
            isDynamic: options.dynamic !== false, isTrigger: !!options.trigger, isSleeping: !!options.asleep,
            collisionResponse: true, collisionFilterGroup: options.layer ?? LAYER.DEFAULT,
            getAabb(out: Float64Array) {
                out[0] = position.x - half[0]; out[1] = position.y - half[1]; out[2] = position.z - half[2];
                out[3] = position.x + half[0]; out[4] = position.y + half[1]; out[5] = position.z + half[2];
                return out;
            },
        };
    }
    /** A still pool with its surface at y = 0, in a running scene whose physics holds `bodies`. */
    function pool(bodies: any[], options: Record<string, unknown> = {}) {
        const scene = new Scene();
        const water = new WaterVolumeNode('w', { size: [20, 2, 20], waveAmplitude: 0, ...options });
        water.setPosition([0, -1, 0]);
        scene.addNode(water);
        water.updateTransforms?.();
        (scene as any).physics = { bodies };
        // Something reads the list (the renderer does each frame): a node nobody reads gathers nothing.
        void water.disturbances;
        return water;
    }

    it('lists what cuts the surface, its waterline and its motion, and nothing clear of it', () => {
        const crate = body([1, 0.1, 2], [0.5, 0.5, 0.5], { v: [0.5, -2, 0] });
        const above = body([3, 5, 3], [0.5, 0.5, 0.5], { v: [0, -9, 0] });
        const sunk = body([-3, -0.9, 0], [0.05, 0.05, 0.05]);
        const ghost = body([0, 0, 0], [0.5, 0.5, 0.5], { trigger: true, v: [0, -1, 0] });
        const asleep = body([4, 0, -4], [0.5, 0.5, 0.5], { asleep: true });
        const water = pool([crate, above, sunk, ghost, asleep]);
        water.update(1 / 60, 0);
        expect(water.disturbances.length).toBe(1);
        const d = water.disturbances[0];
        expect([d.x, d.z]).toEqual([1, 2]);
        expect(d.radius).toBeCloseTo(0.5, 6);
        expect(d.share).toBeCloseTo(1, 6);
        expect([d.vx, d.vy, d.vz]).toEqual([0.5, -2, 0]);
    });

    it('reacts only to the layers it is set to, and keeps that through a save', async () => {
        const CHARACTER = 1 << 4, DEBRIS = 1 << 5;
        const wader = body([0, 0, 0], [0.3, 0.9, 0.3], { v: [1.5, 0, 0], layer: CHARACTER });
        const chip = body([2, 0, 0], [0.2, 0.2, 0.2], { v: [0, -1, 0], layer: DEBRIS });
        const water = pool([wader, chip]);
        expect(water.reactsTo).toBe(ALL_LAYERS);
        water.update(1 / 60, 0);
        expect(water.disturbances.length).toBe(2);
        water.reactsTo = LAYER.DEFAULT | CHARACTER;
        water.update(1 / 60, 0);
        expect(water.disturbances.map(d => d.x)).toEqual([0]);
        water.reactsTo = 0;
        water.update(1 / 60, 0);
        expect(water.disturbances.length).toBe(0);

        // Every layer is the default, and is not written; anything less is.
        expect((await new WaterVolumeNode('a').serialize() as any).waterVolume.reactsTo).toBeUndefined();
        water.reactsTo = LAYER.DEFAULT | CHARACTER;
        const json = JSON.parse(JSON.stringify(await water.serialize()));
        const parent = new Node('p');
        parseNodeJson(parent, json);
        expect((parent.children[0] as WaterVolumeNode).reactsTo).toBe(LAYER.DEFAULT | CHARACTER);
    });

    it('takes a static body moved by its node at the speed it moved, and a still one as the bank', () => {
        const raft = body([0, 0, 0], [1, 0.2, 1], { dynamic: false });
        const pier = body([5, 0, 5], [0.3, 2, 0.3], { dynamic: false });
        const water = pool([raft, pier]);
        water.update(0.1, 0);
        expect(water.disturbances.length).toBe(0);
        raft.position.x = 0.2;
        water.update(0.1, 0.1);
        expect(water.disturbances.length).toBe(1);
        expect(water.disturbances[0].vx).toBeCloseTo(2, 6);
        // A jump is a respawn or a pooled collider placed anew, not a motion.
        raft.position.x = 30;
        water.update(0.1, 0.2);
        expect(water.disturbances.length).toBe(0);
    });

    it('gathers nothing while nothing reads it (a headless host)', async () => {
        const water = pool([body([0, 0, 0], [0.5, 0.5, 0.5], { v: [0, -2, 0] })]);
        (water as any)._disturbancesRead = -Infinity;
        water.update(1 / 60, 0);
        expect((water as any)._disturbances.length).toBe(0);
        void water.disturbances;
        water.update(1 / 60, 0);
        expect(water.disturbances.length).toBe(1);
    });

    it('lists nothing while the scene is being edited', () => {
        const water = pool([body([0, 0, 0], [0.5, 0.5, 0.5], { v: [0, -2, 0] })]);
        const was = authoring.enabled;
        authoring.enabled = true;
        try {
            water.update(1 / 60, 0);
            expect(water.disturbances.length).toBe(0);
        } finally {
            authoring.enabled = was;
        }
    });
});
