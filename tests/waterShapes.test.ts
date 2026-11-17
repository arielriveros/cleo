import { describe, it, expect } from 'vitest';
import { makeBody, box } from './helpers/physicsBodies';
import './helpers/features';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { WaterVolumeNode } from '../src/core/scene/nodes/waterVolumeNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { normaliseWaterBody, resolveWaterBody, waterColumnAt, type ResolvedWaterShape } from '../src/water/waterShapes';
import { gerstnerDisplacement, gerstnerHeightAt, gerstnerWavesForWind } from '../src/physics/water/gerstner';
import { TEST_PHYSICS } from './helpers/testPhysics';
import { carveWater } from '../src/water/carve';

// The Water node's body: one river, lake, ocean or pool as plain data, resolved to world space, joined to
// other Water nodes where a river runs into them, and queried for surface, bed and flow. Plus the Gerstner
// waves the surface and the physics share.

const FRAME = { position: [0, 0, 0], scale: [1, 1, 1] };
const placed = (position: number[]) => ({ position, scale: [1, 1, 1] });
const resolve = (json: any, frame = FRAME, targets = {}) => resolveWaterBody(normaliseWaterBody(json), frame, 'w', targets)!;

/** Water nodes in one scene, so their connections find each other, their world transforms current. */
function sceneOf(...nodes: WaterVolumeNode[]): Scene {
    const scene = new Scene();
    for (const n of nodes) { scene.addNode(n); n.updateTransforms(); }
    return scene;
}

describe('water bodies', () => {
    it('loads a legacy volume as a pool, and round-trips a body', async () => {
        const parent = new Node('p');
        parseNodeJson(parent, { type: 'waterVolume', name: 'old', id: 'a', waterVolume: { size: [8, 2, 6], density: 1000 } } as any);
        const old = parent.children[0] as WaterVolumeNode;
        expect(old.waterType).toBe('pool');
        expect(old.size).toEqual([8, 2, 6]);

        const w = new WaterVolumeNode('w', { waterType: 'river', windSpeed: 6, connect: { end: 'lake-node' } });
        w.points = [...w.points, { pos: [3, -1, 25], width: 7, depth: 1.5, flowSpeed: 0.6 }];
        const json = JSON.parse(JSON.stringify(await w.serialize()));
        expect(json.waterVolume.shapes).toBeUndefined();
        const p2 = new Node('p');
        parseNodeJson(p2, json);
        const back = p2.children[0] as WaterVolumeNode;
        expect(back.waterBody).toEqual(w.waterBody);
        expect(back.flowsInto).toBe('lake-node');
        expect(back.windSpeed).toBe(6);
    });

    it('splits an older multi-shape node into one node per shape, keeping its connections', () => {
        const parent = new Node('p');
        parseNodeJson(parent, {
            type: 'waterVolume', name: 'Lakes and Rivers', id: 'old', position: [100, 0, 0], bakeId: 'x',
            waterVolume: { windSpeed: 3, density: 1010, bakeId: 'stale', shapes: [
                { id: 'lake0', type: 'lake', name: 'Lake', offset: [10, -2, 20] },
                { id: 'river0', type: 'river', name: 'Peak river', offset: [0, 0, 0], connect: { start: null, end: 'lake0' } },
                { id: 'pool0', type: 'box', name: 'Tank', offset: [-5, 1, 0], size: [2, 2, 2] },
            ] },
        } as any);
        const made = parent.children as WaterVolumeNode[];
        expect(made.map(n => n.name)).toEqual(['Lake', 'Peak river', 'Tank']);
        expect(made.map(n => n.waterType)).toEqual(['lake', 'river', 'pool']);
        expect(made[0].id).toBe('old');                       // the first keeps the node's id
        expect(made[1].flowsInto).toBe('old');               // the connection follows the shape to its node
        expect(made[0].worldPosition[1]).toBeCloseTo(-2, 6); // the shape's offset is the node's place now
        expect(made[0].worldPosition[0]).toBeCloseTo(110, 6);
        expect(made[2].size).toEqual([2, 2, 2]);
        expect(made.every(n => n.density === 1010 && n.windSpeed === 3 && !n.bakeId)).toBe(true);
    });

    it('finds a river between its banks, flowing downstream, deepest in the middle', () => {
        const r = resolve({
            type: 'river', points: [
                { pos: [0, 2, 0], width: 6, depth: 2, flowSpeed: 2 },
                { pos: [0, 1, 20], width: 6, depth: 2, flowSpeed: 2 },
                { pos: [0, 0, 40], width: 6, depth: 2, flowSpeed: 2 },
            ],
        });
        const shapes = [r];
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

    it('a river node meets the lake node it flows into, and follows it when it moves', () => {
        const lake = new WaterVolumeNode('lake', { waterType: 'lake' });
        lake.setPosition([0, -3, 50]);
        const river = new WaterVolumeNode('river', { waterType: 'river', points: [
            { pos: [0, 5, 0], width: 4, depth: 1, flowSpeed: 1 }, { pos: [0, 0, 36], width: 4, depth: 1, flowSpeed: 1 },
        ] });
        river.flowsInto = lake.id;
        sceneOf(lake, river);
        const end = river.resolved()!.samples.at(-1)!;
        expect(end.y).toBeCloseTo(-3, 6);
        // It reaches into the lake past the shore, so the two surfaces meet.
        expect(end.z).toBeGreaterThan(42 - 0.5);
        expect(river.handOver().map(h => h.id)).toEqual([lake.id]);
        // The lake moves: the river's mouth follows without the river being touched.
        lake.setPosition([0, -4, 50]);
        lake.updateTransforms();
        expect(river.resolved()!.samples.at(-1)!.y).toBeCloseTo(-4, 6);
        // A connection to a node that is not there is no connection.
        river.flowsInto = 'gone';
        expect(river.handOver()).toEqual([]);
    });

    it('a river can flow into another river, and a cycle resolves without hanging', () => {
        const main = new WaterVolumeNode('main', { waterType: 'river', points: [
            { pos: [-20, 0, 0], width: 6, depth: 2, flowSpeed: 1 }, { pos: [20, -2, 0], width: 6, depth: 2, flowSpeed: 1 },
        ] });
        const trib = new WaterVolumeNode('trib', { waterType: 'river', points: [
            { pos: [0, 4, 30], width: 2, depth: 1, flowSpeed: 2 }, { pos: [0, 3, 0], width: 2, depth: 1, flowSpeed: 2 },
        ] });
        trib.flowsInto = main.id;
        sceneOf(trib, main);
        expect(trib.resolved()!.samples.at(-1)!.y).toBeCloseTo(-1, 1);
        main.flowsFrom = trib.id;   // a loop
        expect(main.resolved()).not.toBeNull();
        expect(trib.resolved()).not.toBeNull();
    });

    it('hands the river mouth over to the lake: not drawn there, and no shore either', async () => {
        const { buildWaterInfo } = await import('../src/water/waterInfo');
        const lake = new WaterVolumeNode('lake', { waterType: 'lake' });
        lake.setPosition([0, 0, 30]);
        const river = new WaterVolumeNode('river', { waterType: 'river', points: [
            { pos: [0, 2, -10], width: 4, depth: 1, flowSpeed: 1 }, { pos: [0, 0.2, 20], width: 4, depth: 1, flowSpeed: 1 },
        ] });
        river.flowsInto = lake.id;
        sceneOf(lake, river);
        const info = buildWaterInfo(river.resolvedShapes(), null, { handOver: river.handOver() })!;
        const cellAt = (x: number, z: number) => {
            const i = Math.round((z - info.originZ) / info.cell) * info.nx + Math.round((x - info.originX) / info.cell);
            return { edge: info.info0[i * 4 + 3], wet: info.info1[i * 4 + 3] };
        };
        expect(cellAt(0, 0).wet).toBe(1);        // the river proper
        expect(cellAt(0, 24).wet).toBe(0);       // inside the lake: the lake draws it
        expect(cellAt(0, 21).edge).toBeGreaterThan(1.5);   // the river's end there is no shore
    });

    it('an endless ocean is everywhere, a pool only inside itself', () => {
        const ocean: ResolvedWaterShape = resolve({ type: 'ocean' }, placed([0, -1, 0]));
        expect(waterColumnAt([ocean], 5000, -9000)!.surface).toBe(-1);
        expect(waterColumnAt([ocean], 5000, -9000)!.edge).toBe(Infinity);
        const pool = resolve({ type: 'pool', size: [4, 2, 4] });
        expect(waterColumnAt([pool], 1, 1)!.surface).toBe(1);
        expect(waterColumnAt([pool], 3, 1)).toBeNull();
    });

    it('changing the type keeps what the types share and starts the rest fresh', () => {
        const w = new WaterVolumeNode('w', { waterType: 'river', connect: { end: 'x' } });
        const v = w.version;
        w.waterType = 'lake';
        expect(w.version).toBeGreaterThan(v);
        expect(w.points.length).toBeGreaterThanOrEqual(3);
        expect(w.flowsInto).toBeNull();
        w.waterType = 'ocean';
        expect(w.points).toEqual([]);
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
        const w = new WaterVolumeNode('sea', { waterType: 'ocean', windSpeed: 8, waveAmplitude: 0 });
        const heights = [0, 1, 2, 3].map(t => w.surfaceHeightAt(5, 5, t));
        expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.05);
    });
});

describe('water physics', () => {
    it('a river carries a floating crate downstream', () => {
        const water = new WaterVolumeNode('river', {
            waterType: 'river', points: [
                { pos: [0, 0, -50], width: 10, depth: 3, flowSpeed: 2 },
                { pos: [0, 0, 50], width: 10, depth: 3, flowSpeed: 2 },
            ],
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
        const river = normaliseWaterBody({
            type: 'river', carve: { enabled: true, bankWidth: 4, extraDepth: 0 }, points: [
                { pos: [0, 2, -30], width: 6, depth: 1.5, flowSpeed: 1 }, { pos: [0, 2, 30], width: 6, depth: 1.5, flowSpeed: 1 },
            ],
        });
        const lake = normaliseWaterBody({ type: 'lake' });   // carve off: untouched
        const grid = { heights, resolution: R, size, origin: [0, 0, 0] };
        const region = carveWater(grid, river, resolveWaterBody(river, FRAME, 'r'))!;
        expect(carveWater(grid, lake, resolveWaterBody(lake, placed([20, 5, 0]), 'l'))).toBeNull();
        expect(region).not.toBeNull();
        const h = (x: number, z: number) => heights[Math.round(z + 32) * R + Math.round(x + 32)];
        expect(h(0, 0)).toBeCloseTo(0.5, 1);            // centre line: surface 2 - depth 1.5
        expect(h(5, 0)).toBeGreaterThan(h(0, 0));       // the bank rises
        expect(h(5, 0)).toBeLessThan(2);
        expect(h(12, 0)).toBe(2);                        // beyond the bank: untouched
        expect(h(20, 0)).toBe(2);                        // the lake does not carve
        const again = carveWater(grid, river, resolveWaterBody(river, FRAME, 'r'));
        expect(h(0, 0)).toBeCloseTo(0.5, 1);             // never digs past the bed
        expect(again === null || again.c0 >= 0).toBe(true);
    });
});

describe('water info and look', () => {
    it('builds a grid with the shore where the ground rises, and tiles only where there is water', async () => {
        const { buildWaterInfo } = await import('../src/water/waterInfo');
        const shapes = [resolve({ type: 'lake' })];
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
        const ocean = buildWaterInfo([resolve({ type: 'ocean' })], null);
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
        const lake = resolveWaterBody(normaliseWaterBody({ type: 'lake' }), placed([0, -1.5, 30]), 'L')!;
        const river = resolveWaterBody(normaliseWaterBody({ type: 'river' }), FRAME, 'R', { end: lake })!;
        const t0 = performance.now();
        const info = bakeShallowWater([river, lake], null, { maxRes: 96, duration: 25 });
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
        expect(at(8, 32).wet).toBe(0);                // the lake's own node draws the lake (handed over)
        expect(ms).toBeLessThan(20000);
        const bytes = encodeWaterBake(info, 'sig');
        const back = decodeWaterBake(bytes)!;
        expect(back.signature).toBe('sig');
        expect(back.info.nx).toBe(info.nx);
        expect(Array.from(back.info.info0.subarray(0, 64))).toEqual(Array.from(info.info0.subarray(0, 64)));
        expect(decodeWaterBake(new Uint8Array(80))).toBeNull();
    });
});

describe('physics on a baked flow', () => {
    it('reads the bake surface and currents, and drops a stale bake', async () => {
        const { bakeShallowWater } = await import('../src/water/bake/shallowWater');
        const { encodeWaterBake } = await import('../src/water/bake/waterBakeFormat');
        const { GiBakeRegistry } = await import('../src/graphics/render/gi/giBakeRegistry');
        const lake = new WaterVolumeNode('lake', { waterType: 'lake' });
        lake.setPosition([0, -1.5, 30]);
        const w = new WaterVolumeNode('river', { waterType: 'river', waveAmplitude: 0 });
        w.flowsInto = lake.id;
        sceneOf(lake, w);
        const info = bakeShallowWater(w.resolvedShapes(), null, { maxRes: 96, duration: 25, handOver: w.handOver() });
        GiBakeRegistry.set('wb-test', encodeWaterBake(info, w.bakeSignature()));
        w.bakeId = 'wb-test';
        const grid = w.bakedFlowGrid()!;
        expect(grid).not.toBeNull();
        const col = w.columnAt(0, 0, 0)!;
        expect(col.flowZ).toBeGreaterThan(0.05);
        // Move the lake it flows into: the bake is stale and physics goes back to the analytic river.
        lake.setPosition([0, -1, 30]);
        lake.updateTransforms?.();
        expect(w.bakedFlowGrid()).toBeNull();
        GiBakeRegistry.delete('wb-test');
    });
});

describe('the water detail texture', () => {
    it('is deterministic, varied, and tiles (its slopes wrap)', async () => {
        const { waterDetailPixels, WATER_DETAIL_SIZE: n } = await import('../src/water/waterTextures');
        const a = waterDetailPixels(), b = waterDetailPixels();
        expect(a).toEqual(b);
        let min = 255, max = 0, foam = 0;
        for (let i = 0; i < n * n; i++) { min = Math.min(min, a[i * 4]); max = Math.max(max, a[i * 4]); if (a[i * 4 + 2] > 128) foam++; }
        expect(max - min).toBeGreaterThan(120);           // real slopes, not a flat map
        expect(foam / (n * n)).toBeGreaterThan(0.03);     // a web, not nothing
        expect(foam / (n * n)).toBeLessThan(0.6);         // and not solid foam
        // Wrapping: the first and last columns' heights are neighbours on a periodic field.
        let jump = 0;
        for (let y = 0; y < n; y++) jump = Math.max(jump, Math.abs(a[(y * n) * 4 + 3] - a[(y * n + n - 1) * 4 + 3]));
        expect(jump).toBeLessThan(60);
    });
});

describe('subsurface scattering on the Water material', () => {
    it('fills, clamps and round-trips the scatter fields', async () => {
        const { normaliseWaterLook, DEFAULT_WATER_LOOK, WATER_LOOK_PRESETS } = await import('../src/water/waterLook');
        const { Material, WaterMaterial } = await import('../src/graphics/material');
        const old = normaliseWaterLook({ turbidity: 0.5 });   // a look saved before the fields existed
        expect(old.scatterColor).toEqual(DEFAULT_WATER_LOOK.scatterColor);
        expect(old.subsurface).toBe(DEFAULT_WATER_LOOK.subsurface);
        const wild = normaliseWaterLook({ subsurface: 9, subsurfaceSharpness: 0, subsurfaceDistortion: -1, scatterColor: [1, 'x', 0.2] });
        expect([wild.subsurface, wild.subsurfaceSharpness, wild.subsurfaceDistortion]).toEqual([2, 1, 0]);
        expect(wild.scatterColor).toEqual([1, DEFAULT_WATER_LOOK.scatterColor[1], 0.2]);
        const m = new WaterMaterial({ subsurface: 1.4, scatterColor: [0.1, 0.7, 0.6], subsurfaceSharpness: 7, subsurfaceDistortion: 0.2 });
        const back = Material.parse(JSON.parse(JSON.stringify(m.serialize()))) as InstanceType<typeof WaterMaterial>;
        expect([back.look.subsurface, back.look.subsurfaceSharpness, back.look.subsurfaceDistortion]).toEqual([1.4, 7, 0.2]);
        expect(back.look.scatterColor).toEqual([0.1, 0.7, 0.6]);
        // Murky water barely scatters forward; clear tropical water the most.
        const of = (id: string) => normaliseWaterLook(WATER_LOOK_PRESETS.find(p => p.id === id)!.options).subsurface;
        expect(of('murkySwamp')).toBeLessThan(of('clearLake'));
        expect(of('tropical')).toBeGreaterThan(of('clearLake'));
    });
});
