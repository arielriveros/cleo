import { describe, it, expect } from 'vitest';
import { makeBody, box } from './helpers/physicsBodies';
import './helpers/features';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { WaterVolumeNode } from '../src/core/scene/nodes/waterVolumeNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { normaliseWaterBody, resolveWaterBody, waterColumnAt, type ResolvedWaterShape } from '../src/water/waterShapes';
import { seaState, waterNoise, WAVE_BEND, WAVE_SHORTEST, waveHeightAt, waveOmega, wavePhase, waveSigma, waveSlopeVariance, waveSurfaceAt, wavesForWind } from '../src/physics/water/waves';
import { TEST_PHYSICS } from './helpers/testPhysics';
import { carveWater } from '../src/water/carve';

// The Water node's body: one river, lake, ocean or pool as plain data, resolved to world space, joined to
// other Water nodes where a river runs into them, and queried for surface, bed and flow. Plus the waves
// the surface and the physics share.

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

    it('a river never rises along its course, whatever its points say, and does not overshoot them', () => {
        // Drawn climbing in the middle (12 after 10, 6 after 4): the water cannot.
        const river = resolve({ type: 'river', points: [10, 12, 4, 6, 0].map((y, i) => ({ pos: [0, y, i * 30], width: 4, depth: 1, flowSpeed: 1 })) });
        const ys = river.samples.map(q => q.y);
        for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1] + 1e-9);
        expect(Math.max(...ys)).toBeCloseTo(10, 6);
        expect(Math.min(...ys)).toBeCloseTo(0, 6);
        // A long level reach and then a drop: a spline through the heights would bulge above 10 before it
        // falls, and dip below 0 after.
        const step = resolve({ type: 'river', points: [10, 10, 0, 0].map((y, i) => ({ pos: [0, y, i * 30], width: 4, depth: 1, flowSpeed: 1 })) });
        for (const q of step.samples) { expect(q.y).toBeLessThanOrEqual(10 + 1e-9); expect(q.y).toBeGreaterThanOrEqual(-1e-9); }
    });

    it('a river drawn below the lake it runs into is backed up to the lake, never lifted to it at the end', () => {
        const lake = new WaterVolumeNode('lake', { waterType: 'lake' });
        lake.setPosition([0, 6, 80]);
        // Its last points lie 4 m and 8 m under the lake's surface.
        const river = new WaterVolumeNode('river', { waterType: 'river', points: [
            { pos: [0, 20, 0], width: 4, depth: 1, flowSpeed: 1 }, { pos: [0, 10, 25], width: 4, depth: 1, flowSpeed: 1 },
            { pos: [0, 2, 50], width: 4, depth: 1, flowSpeed: 1 }, { pos: [0, -2, 66], width: 4, depth: 1, flowSpeed: 1 },
        ] });
        river.flowsInto = lake.id;
        sceneOf(lake, river);
        const ys = river.resolved()!.samples.map(q => q.y);
        for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1] + 1e-9);
        expect(Math.min(...ys)).toBeCloseTo(6, 6);
        expect(ys.at(-1)).toBeCloseTo(6, 6);
        // And a river out of a lake starts at the lake's level, however low its first point was drawn.
        const out = new WaterVolumeNode('out', { waterType: 'river', points: [
            { pos: [0, 1, 96], width: 4, depth: 1, flowSpeed: 1 }, { pos: [0, 0, 140], width: 4, depth: 1, flowSpeed: 1 },
        ] });
        out.flowsFrom = lake.id;
        sceneOf(lake, out);
        const os = out.resolved()!.samples.map(q => q.y);
        expect(os[0]).toBeCloseTo(6, 6);
        expect(Math.max(...os)).toBeCloseTo(6, 6);
        expect(os.at(-1)).toBeCloseTo(0, 6);
    });

    it('a lake has no shore where a river runs into it', async () => {
        const { buildWaterInfo } = await import('../src/water/waterInfo');
        const lake = new WaterVolumeNode('lake', { waterType: 'lake' });
        lake.setPosition([0, 0, 30]);
        const river = new WaterVolumeNode('river', { waterType: 'river', points: [
            { pos: [0, 2, -10], width: 6, depth: 1, flowSpeed: 1 }, { pos: [0, 0.2, 20], width: 6, depth: 1, flowSpeed: 1 },
        ] });
        river.flowsInto = lake.id;
        sceneOf(lake, river);
        expect(lake.joinedRivers()).toEqual([river]);
        expect(river.beside()).toEqual([]);
        const mouth = river.resolved()!.samples.at(-1)!;
        const edgeAt = (info: NonNullable<ReturnType<typeof buildWaterInfo>>, x: number, z: number) =>
            info.info0[(Math.round((z - info.originZ) / info.cell) * info.nx + Math.round((x - info.originX) / info.cell)) * 4 + 3];
        const alone = buildWaterInfo(lake.resolvedShapes(), null)!;
        const joined = buildWaterInfo(lake.resolvedShapes(), null, { beside: lake.beside() })!;
        // Just inside the lake at the mouth: the lake's own outline is the shore without the river; with it,
        // the nearest shore is the river's bank (half its width away, and a little along).
        expect(edgeAt(alone, mouth.x, mouth.z)).toBeLessThan(3);
        expect(edgeAt(joined, mouth.x, mouth.z)).toBeGreaterThan(edgeAt(alone, mouth.x, mouth.z) + 1);
        expect(edgeAt(joined, mouth.x, mouth.z)).toBeGreaterThan(3);
        // The lake's key changes when the river does, so its grid is rebuilt.
        const key = lake.besideKey();
        river.points = [{ pos: [3, 2, -10], width: 6, depth: 1, flowSpeed: 1 }, { pos: [0, 0.2, 20], width: 6, depth: 1, flowSpeed: 1 }];
        expect(lake.besideKey()).not.toBe(key);
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

describe('waves', () => {
    it("a wind's set has the sea's significant height and Cox and Munk's slope", () => {
        for (const [U, F] of [[7, Infinity], [12, Infinity], [7, 300], [4, 80]]) {
            const waves = wavesForWind(U, 30, F);
            expect(waves.length).toBeGreaterThan(5);
            // Longest first, down to the capillary ripples.
            for (let i = 1; i < waves.length; i++) expect(waves[i].wavelength).toBeLessThan(waves[i - 1].wavelength);
            expect(waves[waves.length - 1].wavelength).toBeGreaterThanOrEqual(WAVE_SHORTEST * 0.99);
            expect(4 * waveSigma(waves) / seaState(U, F).hs).toBeCloseTo(1, 2);
            expect(waveSlopeVariance(waves) / (0.003 + 0.00512 * U)).toBeCloseTo(1, 2);
        }
    });

    it('rides the resting level, its spread as measured', () => {
        const waves = wavesForWind(9, 30, Infinity);
        let s = 0, s2 = 0, n = 0;
        for (let x = 0; x < 400; x += 3.1) for (let z = 0; z < 400; z += 2.7) {
            const h = waveHeightAt(waves, x, z, 17.3, 1, 0);
            s += h; s2 += h * h; n++;
        }
        const sigma = waveSigma(waves);
        expect(Math.abs(s / n)).toBeLessThan(0.1 * sigma);
        expect(Math.sqrt(s2 / n - (s / n) ** 2) / sigma).toBeGreaterThan(0.8);
        expect(Math.sqrt(s2 / n - (s / n) ** 2) / sigma).toBeLessThan(1.2);
    });

    it("reports the water's vertical speed as the surface rises and falls", () => {
        const waves = wavesForWind(9, 30, Infinity, { choppiness: 0.8 });
        const out = { height: 0, vx: 0, vy: 0, vz: 0, k: 0 };
        for (const [x, z, t] of [[3, 7, 1.5], [-40, 12, 9], [100, -3, 33]]) {
            const dt = 1e-3;
            const h0 = waveHeightAt(waves, x, z, t - dt, 1), h1 = waveHeightAt(waves, x, z, t + dt, 1);
            waveSurfaceAt(waves, x, z, t, 1, 1, 0.5, out);
            expect(out.vy).toBeCloseTo((h1 - h0) / (2 * dt), 2);
        }
    });

    it("the shader's per-pixel slope is the height's: the drag's Jacobian and the bent crests carried exactly", () => {
        // water.wgsl waveStack, operation for operation, with every wave resolved: the slope it builds from the
        // warp's Jacobian and the bend noise's analytic gradient must be the height field's true gradient.
        const waves = wavesForWind(10, 40, 8000, { choppiness: 0.9 });
        const t = 7.7;
        const corner = (x: number, y: number) => waterNoise(x, y);   // value noise at a lattice point is its hash
        const noiseGrad = (x: number, y: number) => {
            const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
            const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
            const dux = 6 * fx * (1 - fx), duy = 6 * fy * (1 - fy);
            const a = corner(ix, iy), b = corner(ix + 1, iy), c = corner(ix, iy + 1), d = corner(ix + 1, iy + 1);
            const k = a - b - c + d;
            return [dux * ((b - a) + k * uy), duy * ((c - a) + k * ux)];
        };
        const shaderSlope = (x0: number, z0: number) => {
            let px = x0, pz = z0;
            let j00 = 1, j01 = 0, j10 = 0, j11 = 1;   // J[column][row]: column 0 is d p / d x0
            let gx = 0, gz = 0;
            waves.forEach((w, i) => {
                const k = 2 * Math.PI / w.wavelength, kx = w.dirX * k, kz = w.dirZ * k;
                const qx = x0 / w.wavelength + i * 17.3, qz = z0 / w.wavelength + i * 7.1;
                const ng = noiseGrad(qx, qz);
                const theta = kx * px + kz * pz - waveOmega(k) * t + wavePhase(i) + WAVE_BEND * (waterNoise(qx, qz) - 0.5);
                const s = Math.sin(theta), c = Math.cos(theta), e = Math.exp(s - 1);
                const dtx = j00 * kx + j01 * kz + ng[0] * WAVE_BEND / w.wavelength;
                const dtz = j10 * kx + j11 * kz + ng[1] * WAVE_BEND / w.wavelength;
                gx += dtx * w.amplitude * e * c; gz += dtz * w.amplitude * e * c;
                px += w.dirX * (-w.drag * w.amplitude * e * c); pz += w.dirZ * (-w.drag * w.amplitude * e * c);
                const q = -w.drag * w.amplitude * e * (c * c - s);
                j00 += w.dirX * q * dtx; j01 += w.dirZ * q * dtx;
                j10 += w.dirX * q * dtz; j11 += w.dirZ * q * dtz;
            });
            return [gx, gz];
        };
        for (const [x, z] of [[3, 7], [-41.3, 12.9], [104.2, -3.3], [0.37, 0.91]]) {
            const h = 1e-4;
            const fx = (waveHeightAt(waves, x + h, z, t, 1, 0) - waveHeightAt(waves, x - h, z, t, 1, 0)) / (2 * h);
            const fz = (waveHeightAt(waves, x, z + h, t, 1, 0) - waveHeightAt(waves, x, z - h, t, 1, 0)) / (2 * h);
            const [sx, sz] = shaderSlope(x, z);
            expect(sx).toBeCloseTo(fx, 3);
            expect(sz).toBeCloseTo(fz, 3);
        }
    });

    it('a short fetch raises a young sea: shorter, steeper waves', () => {
        const open = seaState(12, Infinity), young = seaState(12, 10000);
        expect(young.peak).toBeLessThan(open.peak / 4);
        expect(young.hs / young.peak).toBeGreaterThan(1.3 * open.hs / open.peak);
        // The node's own fetch overrides the body's, and is saved.
        const sea = new WaterVolumeNode('sea', { waterType: 'ocean', windSpeed: 12, fetch: 10000 });
        expect(sea.waves()[0].wavelength).toBeCloseTo(young.peak, 6);
        expect(new WaterVolumeNode('sea', { waterType: 'ocean', windSpeed: 12 }).waves()[0].wavelength).toBeCloseTo(open.peak, 6);
        expect((sea as any)._serializePayload().waterVolume.fetch).toBe(10000);
    });

    it('grows with the wind and is limited by fetch', () => {
        const height = (U: number, F: number) => waveSigma(wavesForWind(U, 0, F));
        expect(height(15, Infinity)).toBeGreaterThan(height(5, Infinity));
        expect(height(15, 200)).toBeLessThan(height(15, Infinity));
        expect(wavesForWind(0, 0, Infinity)).toEqual([]);
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

    it('a river that runs into the sea carries a crate down its whole length, not only at its mouth', () => {
        // The sea is everywhere under the river (no landscape says where the land is), 6 m below its head.
        const sea = new WaterVolumeNode('sea', { waterType: 'ocean', waveAmplitude: 0 });
        const river = new WaterVolumeNode('river', {
            waterType: 'river', points: [
                { pos: [0, 6, -80], width: 10, depth: 2, flowSpeed: 2 },
                { pos: [0, 0, 40], width: 10, depth: 2, flowSpeed: 2 },
            ],
            waveAmplitude: 0,
        });
        river.flowsInto = sea.id;
        sceneOf(sea, river);
        const p = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: TEST_PHYSICS });
        p.initialize();
        (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null, waterVolumes: new Set([sea, river]) };
        const at = river.columnAt(0, -60)!;
        const crate = makeBody(box(0.5, 0.5, 0.5), { mass: 250, position: [0, at.surface + 0.2, -60] });
        p.addBody(crate);
        for (let i = 0; i < 300; i++) p.update(1 / 60);
        // Carried downstream on the river's own surface, well above the sea under it.
        expect(crate.position.z).toBeGreaterThan(-54);
        expect(crate.position.y).toBeGreaterThan(river.columnAt(0, crate.position.z)!.surface - 0.6);
        expect(crate.position.y).toBeGreaterThan(1.5);
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
