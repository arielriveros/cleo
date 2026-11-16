import { describe, it, expect } from 'vitest';
import { makeBody, box } from './helpers/physicsBodies';
import './helpers/features';
import { Node } from '../src/core/scene/nodes/node';
import { WaterVolumeNode } from '../src/core/scene/nodes/waterVolumeNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { normaliseWaterShape, resolveWaterShapes, waterColumnAt } from '../src/water/waterShapes';
import { gerstnerDisplacement, gerstnerHeightAt, gerstnerWavesForWind } from '../src/physics/water/gerstner';
import { TEST_PHYSICS } from './helpers/testPhysics';
import { carveWater } from '../src/water/carve';

// The Water node's shapes: rivers, lakes, boxes and oceans as plain data, resolved to world space, joined
// where a river runs into something, and queried for surface, bed and flow. Plus the Gerstner waves the
// surface and the physics share.

const FRAME = { position: [0, 0, 0], scale: [1, 1, 1] };

describe('water shapes', () => {
    it('migrates a legacy volume to one box, and round-trips shapes', async () => {
        const parent = new Node('p');
        parseNodeJson(parent, { type: 'waterVolume', name: 'old', id: 'a', waterVolume: { size: [8, 2, 6], density: 1000 } } as any);
        const old = parent.children[0] as WaterVolumeNode;
        expect(old.shapes.length).toBe(1);
        expect(old.shapes[0].type).toBe('box');
        expect(old.size).toEqual([8, 2, 6]);

        const w = new WaterVolumeNode('w', { shapes: [{ type: 'river' }, { type: 'lake', offset: [0, -1, 30] }], windSpeed: 6 });
        w.shapes = [...w.shapes, { ...w.shapes[0], id: 'r2', connect: { start: null, end: w.shapes[1].id } }];
        const json = JSON.parse(JSON.stringify(await w.serialize()));
        const p2 = new Node('p');
        parseNodeJson(p2, json);
        const back = p2.children[0] as WaterVolumeNode;
        expect(back.shapes).toEqual(w.shapes);
        expect(back.windSpeed).toBe(6);
    });

    it('finds a river between its banks, flowing downstream, deepest in the middle', () => {
        const river = normaliseWaterShape({
            type: 'river', points: [
                { pos: [0, 2, 0], width: 6, depth: 2, flowSpeed: 2 },
                { pos: [0, 1, 20], width: 6, depth: 2, flowSpeed: 2 },
                { pos: [0, 0, 40], width: 6, depth: 2, flowSpeed: 2 },
            ],
        });
        const shapes = resolveWaterShapes([river], FRAME);
        const mid = waterColumnAt(shapes, 0, 20)!;
        expect(mid).not.toBeNull();
        expect(mid.surface).toBeCloseTo(1, 1);
        expect(mid.flowZ).toBeGreaterThan(1.5);
        expect(Math.abs(mid.flowX)).toBeLessThan(0.1);
        const nearBank = waterColumnAt(shapes, 2.5, 20)!;
        expect(nearBank.floor).toBeGreaterThan(mid.floor);
        expect(nearBank.flowZ).toBeLessThan(mid.flowZ);
        expect(waterColumnAt(shapes, 3.5, 20)).toBeNull();
        expect(waterColumnAt(shapes, 0, 10)!.surface).toBeGreaterThan(waterColumnAt(shapes, 0, 30)!.surface);
    });

    it('meets the lake it runs into, and the higher priority wins where they overlap', () => {
        const lake = normaliseWaterShape({ type: 'lake', id: 'lake', offset: [0, -3, 50], priority: 0 });
        const river = normaliseWaterShape({
            type: 'river', priority: 1, connect: { start: null, end: 'lake' }, points: [
                { pos: [0, 5, 0], width: 4, depth: 1, flowSpeed: 1 },
                { pos: [0, 0, 45], width: 4, depth: 1, flowSpeed: 1 },
            ],
        });
        const shapes = resolveWaterShapes([lake, river], FRAME);
        const end = shapes.find(s => s.type === 'river')!.samples.at(-1)!;
        expect(end.y).toBeCloseTo(-3, 6);
        // Inside the lake outline, on the river's line: the river (priority 1) is the water there.
        const both = waterColumnAt(shapes, 0, 44)!;
        expect(shapes[both.shape].type).toBe('river');
        // Away from the river, the lake.
        const lakeOnly = waterColumnAt(shapes, 8, 50)!;
        expect(shapes[lakeOnly.shape].type).toBe('lake');
        expect(lakeOnly.surface).toBeCloseTo(-3, 6);
        expect(waterColumnAt(shapes, 30, 50)).toBeNull();
    });

    it('a river can flow into another river', () => {
        const main = normaliseWaterShape({ type: 'river', id: 'main', points: [
            { pos: [-20, 0, 0], width: 6, depth: 2, flowSpeed: 1 }, { pos: [20, -2, 0], width: 6, depth: 2, flowSpeed: 1 },
        ] });
        const trib = normaliseWaterShape({ type: 'river', id: 'trib', connect: { start: null, end: 'main' }, points: [
            { pos: [0, 4, 30], width: 2, depth: 1, flowSpeed: 2 }, { pos: [0, 3, 0], width: 2, depth: 1, flowSpeed: 2 },
        ] });
        // Listed first, the tributary still resolves after what it joins.
        const shapes = resolveWaterShapes([trib, main], FRAME);
        const end = shapes.find(s => s.id === 'trib')!.samples.at(-1)!;
        expect(end.y).toBeCloseTo(-1, 1);
    });

    it('an endless ocean is everywhere, a box only inside itself', () => {
        const shapes = resolveWaterShapes([
            normaliseWaterShape({ type: 'ocean', offset: [0, -1, 0] }),
            normaliseWaterShape({ type: 'box', offset: [0, 0, 0], size: [4, 2, 4], priority: 2 }),
        ], FRAME);
        expect(waterColumnAt(shapes, 5000, -9000)!.surface).toBe(-1);
        expect(waterColumnAt(shapes, 5000, -9000)!.edge).toBe(Infinity);
        expect(waterColumnAt(shapes, 1, 1)!.surface).toBe(1);
    });
});

describe('Gerstner waves', () => {
    it('heightAt finds the displaced surface over a world point', () => {
        const waves = gerstnerWavesForWind(9, 30, Infinity, { choppiness: 0.7 });
        expect(waves.length).toBeGreaterThan(3);
        const d = [0, 0, 0];
        for (const [x, z, t] of [[3, 7, 1.5], [-40, 12, 9], [100, -3, 33]]) {
            gerstnerDisplacement(waves, x, z, t, 1, d);
            expect(gerstnerHeightAt(waves, x + d[0], z + d[2], t, 1)).toBeCloseTo(d[1], 2);
        }
    });

    it('grows with the wind and is limited by fetch', () => {
        const height = (ws: ReturnType<typeof gerstnerWavesForWind>) => ws.reduce((s, w) => s + w.amplitude, 0);
        expect(height(gerstnerWavesForWind(15, 0, Infinity))).toBeGreaterThan(height(gerstnerWavesForWind(5, 0, Infinity)));
        expect(height(gerstnerWavesForWind(15, 0, 200))).toBeLessThan(height(gerstnerWavesForWind(15, 0, Infinity)));
        expect(gerstnerWavesForWind(0, 0, Infinity)).toEqual([]);
    });

    it('floating bodies ride the waves the node reports', () => {
        const w = new WaterVolumeNode('sea', { shapes: [{ type: 'ocean', offset: [0, 0, 0] }], windSpeed: 8, waveAmplitude: 0 });
        const heights = [0, 1, 2, 3].map(t => w.surfaceHeightAt(5, 5, t));
        expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.05);
    });
});

describe('water physics', () => {
    it('a river carries a floating crate downstream', () => {
        const water = new WaterVolumeNode('river', {
            shapes: [{
                type: 'river', points: [
                    { pos: [0, 0, -50], width: 10, depth: 3, flowSpeed: 2 },
                    { pos: [0, 0, 50], width: 10, depth: 3, flowSpeed: 2 },
                ],
            }],
            waveAmplitude: 0,
        });
        water.updateTransforms?.();
        const p = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: TEST_PHYSICS });
        p.initialize();
        (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null, waterVolumes: new Set([water]) };
        const crate = makeBody(box(0.5, 0.5, 0.5), { mass: 250, position: [0, 0.3, -20] });
        p.addBody(crate);
        for (let i = 0; i < 300; i++) p.update(1 / 60);
        expect(crate.position.z).toBeGreaterThan(-15);
        expect(crate.position.y).toBeGreaterThan(-0.5);
    });
});

describe('carving', () => {
    it('digs a river bed with banks into a flat grid, and only lowers', () => {
        const R = 65, size = 64;
        const heights = new Float32Array(R * R).fill(2);
        const river = normaliseWaterShape({
            type: 'river', carve: { enabled: true, bankWidth: 4, extraDepth: 0 }, points: [
                { pos: [0, 2, -30], width: 6, depth: 1.5, flowSpeed: 1 }, { pos: [0, 2, 30], width: 6, depth: 1.5, flowSpeed: 1 },
            ],
        });
        const lake = normaliseWaterShape({ type: 'lake', offset: [20, 5, 0] });   // carve off: untouched
        const resolved = resolveWaterShapes([river, lake], FRAME);
        const region = carveWater({ heights, resolution: R, size, origin: [0, 0, 0] }, [river, lake], resolved)!;
        expect(region).not.toBeNull();
        const at = (x: number, z: number) => heights[Math.round(z + 32) * R + Math.round(x + 32)];
        expect(at(0, 0)).toBeCloseTo(0.5, 1);            // centre line: surface 2 - depth 1.5
        expect(at(5, 0)).toBeGreaterThan(at(0, 0));       // the bank rises
        expect(at(5, 0)).toBeLessThan(2);
        expect(at(12, 0)).toBe(2);                        // beyond the bank: untouched
        expect(at(20, 0)).toBe(2);                        // the lake does not carve
        const again = carveWater({ heights, resolution: R, size, origin: [0, 0, 0] }, [river], resolved);
        expect(at(0, 0)).toBeCloseTo(0.5, 1);             // never digs past the bed
        expect(again === null || again.c0 >= 0).toBe(true);
    });
});

describe('water info and look', () => {
    it('builds a grid with the shore where the ground rises, and tiles only where there is water', async () => {
        const { buildWaterInfo } = await import('../src/water/waterInfo');
        const lake = normaliseWaterShape({ type: 'lake', offset: [0, 0, 0] });
        const shapes = resolveWaterShapes([lake], FRAME);
        // Ground rising to the east: dry past x = 6.
        const info = buildWaterInfo(shapes, (x) => (x - 6) * 0.5)!;
        expect(info).not.toBeNull();
        const at = (x: number, z: number) => {
            const i = Math.round((z - info.originZ) / info.cell) * info.nx + Math.round((x - info.originX) / info.cell);
            return { surface: info.info0[i * 4], edge: info.info0[i * 4 + 3], wet: info.info1[i * 4 + 3] };
        };
        expect(at(0, 0).wet).toBe(1);
        expect(at(0, 0).surface).toBeCloseTo(0, 6);
        expect(at(9, 0).wet).toBe(0);
        expect(at(4, 0).edge).toBeLessThan(at(-4, 0).edge);   // nearer the eastern shore the ground made
        expect(info.tileWet.some(t => t === 1)).toBe(true);
        const ocean = buildWaterInfo(resolveWaterShapes([normaliseWaterShape({ type: 'ocean' })], FRAME), null);
        expect(ocean).toBeNull();   // an endless ocean alone needs no grid
    });

    it('a Water material round-trips its look through Material.parse', async () => {
        const { Material, WaterMaterial } = await import('../src/graphics/material');
        const m = new WaterMaterial({ turbidity: 0.7, shallowColor: [0.2, 0.3, 0.1] });
        const back = Material.parse(JSON.parse(JSON.stringify(m.serialize())));
        expect(back).toBeInstanceOf(WaterMaterial);
        expect((back as InstanceType<typeof WaterMaterial>).look.turbidity).toBe(0.7);
        expect((back as InstanceType<typeof WaterMaterial>).look.shallowColor).toEqual([0.2, 0.3, 0.1]);
        const w = new WaterVolumeNode('w', { waterMaterial: m.serialize(), waterMaterialId: 'abc' });
        const json = JSON.parse(JSON.stringify(await w.serialize()));
        const p = new Node('p'); parseNodeJson(p, json);
        expect((p.children[0] as WaterVolumeNode).waterMaterial?.look.turbidity).toBe(0.7);
        expect((p.children[0] as WaterVolumeNode).waterMaterialId).toBe('abc');
    });
});

describe('the shallow-water bake', () => {
    it('settles a river running downhill into its lake, flowing downstream, and round-trips its bytes', async () => {
        const { bakeShallowWater } = await import('../src/water/bake/shallowWater');
        const { encodeWaterBake, decodeWaterBake } = await import('../src/water/bake/waterBakeFormat');
        const lake = normaliseWaterShape({ type: 'lake', id: 'L', offset: [0, -1.5, 30] });
        const river = normaliseWaterShape({ type: 'river', connect: { start: null, end: 'L' } });
        const shapes = resolveWaterShapes([river, lake], FRAME);
        const t0 = performance.now();
        const info = bakeShallowWater(shapes, null, { maxRes: 96, duration: 25 });
        const ms = performance.now() - t0;
        const at = (x: number, z: number) => {
            const i = Math.round((z - info.originZ) / info.cell) * info.nx + Math.round((x - info.originX) / info.cell);
            return { surface: info.info0[i * 4], u: info.info0[i * 4 + 1], v: info.info0[i * 4 + 2], wet: info.info1[i * 4 + 3] };
        };
        const mid = at(0, 0);
        expect(mid.wet).toBe(1);
        expect(mid.v).toBeGreaterThan(0.05);          // downstream is +z
        expect(Math.abs(mid.u)).toBeLessThan(mid.v);
        expect(at(0, -10).surface).toBeGreaterThan(at(0, 10).surface);
        expect(at(8, 32).wet).toBe(1);                // the lake kept its water
        expect(ms).toBeLessThan(20000);
        const bytes = encodeWaterBake(info, 'sig');
        const back = decodeWaterBake(bytes)!;
        expect(back.signature).toBe('sig');
        expect(back.info.nx).toBe(info.nx);
        expect(Array.from(back.info.info0.subarray(0, 64))).toEqual(Array.from(info.info0.subarray(0, 64)));
        expect(decodeWaterBake(new Uint8Array(80))).toBeNull();
    });
});
