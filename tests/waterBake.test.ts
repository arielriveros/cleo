import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import './helpers/features';
import { Scene } from '../src/core/scene/scene';
import { WaterVolumeNode } from '../src/core/scene/nodes/waterVolumeNode';
import { ColliderNode } from '../src/core/scene/nodes/colliderNode';
import { normaliseWaterBody, resolveWaterBody } from '../src/water/waterShapes';
import { bakeWater, riverDischarge, ShallowWaterBake, CELL_HELD, CELL_LEAK, CELL_WALL, CELL_WATER } from '../src/water/bake/shallowWater';
import { transportFoam } from '../src/water/bake/foam';
import { prepareWaterBake, prepareWaterGroup } from '../src/water/bake/groupSetup';
import { sceneObstacles, obstacleSpan } from '../src/water/bake/obstacles';
import { forgetWaterBakeContext, prepareGroupBake, waterBakeGroup } from '../src/water/bake/bakeNode';
import { encodeWaterBake } from '../src/water/bake/waterBakeFormat';
import { GiBakeRegistry } from '../src/graphics/render/gi/giBakeRegistry';
import type { WaterInfo } from '../src/water/waterInfo';

// The water flow bake (water/bake/): the shallow-water equations over a whole connected system of water, the
// ground and the static obstacles in it. Water must run where the ground lets it (round a rock that stands
// out of it, over one under it, over a sill and on, off a course with no channel), settle at the speed
// Manning's friction gives its slope, carry a river's discharge through its lake and out the other side, and
// come out the same every time.

const FRAME = { position: [0, 0, 0], scale: [1, 1, 1] };
const SLOPE = 0.002;
/** A channel `half` metres either side of x = 0, cut in ground falling `slope` per metre toward +z. */
const channel = (half: number, slope = SLOPE) => (x: number, z: number) => -slope * z + Math.max(0, Math.abs(x) - half) * 0.5;

/** A straight river down the channel, `width` wide, from z = 0 to z = `length`, drawn a metre over its bed. */
function straightRiver(width: number, length: number, slope = SLOPE, speed = 1) {
    const points = [0, length / 2, length].map(z => ({ pos: [0, -slope * z + 1, z] as [number, number, number], width, depth: 1, flowSpeed: speed }));
    return resolveWaterBody(normaliseWaterBody({ type: 'river', points }), FRAME, 'river')!;
}

/** A static collider-like object (what sceneObstacles reads) with one box. */
function rock(x: number, y: number, z: number, w: number, h: number, d: number) {
    return {
        nodeType: 'collider', id: `rock${x},${z}`, mass: 0, simulatePhysics: true,
        shapes: [{ type: 'box', width: w, height: h, depth: d, offset: [0, 0, 0], rotation: [0, 0, 0] }],
        worldTransform: mat4.fromTranslation(mat4.create(), [x, y, z]), worldScale: [1, 1, 1],
    };
}

const at = (info: WaterInfo, x: number, z: number) => {
    const i = Math.round((z - info.originZ) / info.cell) * info.nx + Math.round((x - info.originX) / info.cell);
    return {
        surface: info.info0[i * 4], u: info.info0[i * 4 + 1], v: info.info0[i * 4 + 2], edge: info.info0[i * 4 + 3],
        foam: info.info1[i * 4 + 1], bed: info.info1[i * 4 + 2], wet: info.info1[i * 4 + 3],
        speed: Math.hypot(info.info0[i * 4 + 1], info.info0[i * 4 + 2]),
    };
};

describe('the water flow bake', { timeout: 120000 }, () => {
    it('finds where a static box stands and how far up it reaches', () => {
        const [o] = sceneObstacles([rock(0, 1, 0, 2, 4, 2)]);
        const span = obstacleSpan(o, 0.3, -0.4)!;
        expect(span[0]).toBeCloseTo(-1, 1);
        expect(span[1]).toBeCloseTo(3, 1);
        expect(obstacleSpan(o, 1.5, 0)).toBeNull();
        // A dynamic collider is no obstacle.
        expect(sceneObstacles([{ ...rock(0, 1, 0, 2, 4, 2), mass: 5 }])).toEqual([]);
    });

    it('settles a river at the speed Manning gives its slope and depth, and says it has settled', () => {
        const river = straightRiver(30, 200);
        const ground = channel(15);
        const { members, report } = bakeWater(prepareWaterBake(river, [], ground, [], { maxRes: 128, manning: 0.03 }));
        const info = members[0].info;
        // What rises at the head leaves at the end: nothing lost over the banks.
        expect(report.settled).toBe(true);
        expect(report.inflow).toBeCloseTo(riverDischarge(river.samples[0]), 1);
        expect(Math.abs(report.outflow - report.inflow) / report.inflow).toBeLessThan(0.05);
        expect(report.lost).toBeLessThan(0.01 * report.inflow);
        // Upstream of the outfall's drawdown (the water speeds up and thins before a free drop, as a real
        // channel's does), where the flow is uniform.
        const mid = at(info, 0, 80);
        const depth = mid.surface - ground(0, 80);
        // The bed's roughness, or what a stream on this slope measures if that is rougher (Jarrett).
        const n = Math.max(0.03, 0.32 * Math.pow(SLOPE, 0.38) / Math.pow(depth, 1 / 6));
        const manning = Math.pow(depth, 2 / 3) * Math.sqrt(SLOPE) / n;
        expect(mid.v).toBeGreaterThan(0.2);                          // downstream
        expect(Math.abs(mid.speed - manning) / manning).toBeLessThan(0.12);
    });

    it('goes round a rock standing out of the water, faster beside it than above it', () => {
        const river = straightRiver(12, 80);
        const ground = channel(6);
        const obstacles = sceneObstacles([rock(0, ground(0, 40) + 1, 40, 3, 6, 3)]);
        const setup = prepareWaterBake(river, [], ground, obstacles, { maxRes: 160 });
        const centre = Math.round((40 - setup.originZ) / setup.cell) * setup.nx + Math.round((0 - setup.originX) / setup.cell);
        expect(setup.kind[centre]).toBe(CELL_WALL);
        const info = bakeWater(setup).members[0].info;
        expect(at(info, 0, 40).wet).toBe(0);
        const beside = (at(info, 3, 40).speed + at(info, -3, 40).speed) / 2;
        const upstream = (at(info, 3, 20).speed + at(info, -3, 20).speed) / 2;
        expect(beside).toBeGreaterThan(upstream);
    });

    it('speeds up over a rock under the water', () => {
        const river = straightRiver(10, 80);
        const ground = channel(5);
        const obstacles = sceneObstacles([rock(0, ground(0, 40) - 0.2, 40, 4, 0.8, 4)]);
        const info = bakeWater(prepareWaterBake(river, [], ground, obstacles, { maxRes: 160 })).members[0].info;
        expect(at(info, 0, 40).wet).toBe(1);
        expect(at(info, 0, 40).speed).toBeGreaterThan(at(info, 0, 20).speed);
    });

    it('is not dammed by ground higher than the line it was drawn on: it pools behind the sill and runs on over it', () => {
        // A sill a metre and a half high right across the channel, half a metre above the river's drawn surface.
        const slope = 0.02;
        const bedOf = channel(6, slope);
        const ground = (x: number, z: number) => bedOf(x, z) + 1.5 * Math.exp(-((z - 90) * (z - 90)) / 18);
        const river = straightRiver(12, 150, slope);
        const { members, report } = bakeWater(prepareWaterBake(river, [], ground, [], { maxRes: 192 }));
        const info = members[0].info;
        expect(report.settled).toBe(true);
        expect(Math.abs(report.outflow - report.inflow) / report.inflow).toBeLessThan(0.05);
        // Behind the sill the water stands deeper than it was drawn, level with the sill's crest and a little over.
        const pool = at(info, 0, 80);
        expect(pool.wet).toBe(1);
        expect(pool.surface).toBeGreaterThan(ground(0, 90));
        expect(pool.surface - ground(0, 80)).toBeGreaterThan(1.2);
        // Over the crest it is thin and fast, and it carries on down the channel beyond.
        expect(at(info, 0, 90).wet).toBe(1);
        expect(at(info, 0, 90).speed).toBeGreaterThan(pool.speed);
        const below = at(info, 0, 125);
        expect(below.wet).toBe(1);
        expect(below.v).toBeGreaterThan(0.3);
        // It never stands above the pool behind it.
        expect(below.surface).toBeLessThan(pool.surface);
        // Foam: none on the slow pool nor on the smooth water over the crest, most where the water tumbles down
        // the sill's face, and carried on from there, fading, to nothing a way below.
        let fall = 0, fallAt = 0;
        for (let z = 86; z <= 102; z += 1) { const f = at(info, 0, z).foam; if (f > fall) { fall = f; fallAt = z; } }
        expect(at(info, 0, 75).foam).toBeLessThan(0.02);
        expect(fall).toBeGreaterThan(0.1);
        expect(fallAt).toBeGreaterThan(90);
        expect(at(info, 0, 100).foam).toBeGreaterThan(at(info, 0, 75).foam + 0.03);
        expect(at(info, 0, 100).foam).toBeLessThan(fall);
        expect(at(info, 0, 130).foam).toBeLessThan(0.02);
    });

    it('whitens water by the head it loses: a gentle river clear, a torrent streaked, the foot of a drop white', () => {
        // A channel running down +z, 8 cells wide, a metre a cell.
        const nx = 8, nz = 220;
        const field = (surfaceAt: (z: number) => number, speedAt: (z: number) => number) => {
            const n = nx * nz;
            const f = { nx, nz, cell: 1, water: new Uint8Array(n).fill(1), surface: new Float32Array(n), depth: new Float32Array(n).fill(0.5), u: new Float32Array(n), v: new Float32Array(n) };
            for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { f.surface[z * nx + x] = surfaceAt(z); f.v[z * nx + x] = speedAt(z); }
            return transportFoam(f);
        };
        const mid = (foam: Float32Array, z: number) => foam[z * nx + 4];
        // One in a hundred at a metre a second: it loses a centimetre of head a second.
        expect(mid(field(z => -0.01 * z, () => 1), 150)).toBeLessThan(0.02);
        // One in four at two metres a second: half a metre a second.
        const torrent = mid(field(z => -0.25 * z, () => 2), 150);
        expect(torrent).toBeGreaterThan(0.2);
        expect(torrent).toBeLessThan(0.8);
        // A gentle river that drops a metre and a half in three metres, shoots off at 4 m/s and slows again
        // below: the smooth water above the lip carries none, the foot of the drop is white, and the foam is
        // gone again a few seconds downstream.
        const drop = field(
            z => -0.01 * z - 1.5 * Math.min(1, Math.max(0, (z - 100) / 3)),
            z => z < 100 ? 1.2 : z < 104 ? 1.2 + 2.8 * Math.min(1, (z - 100) / 3) : 1.5,
        );
        expect(mid(drop, 98)).toBeLessThan(0.02);
        let foot = 0;
        for (let z = 103; z <= 108; z++) foot = Math.max(foot, mid(drop, z));
        expect(foot).toBeGreaterThan(0.5);
        expect(mid(drop, 112)).toBeLessThan(foot);
        expect(mid(drop, 112)).toBeGreaterThan(0.05);
        expect(mid(drop, 140)).toBeLessThan(0.05);
    });

    it('loses a river drawn where the ground has no channel, and says where it went', () => {
        // Ground tilted toward +x as well as downstream: the water runs off sideways out of its corridor.
        const ground = (x: number, z: number) => -0.01 * z - 0.08 * x;
        const river = straightRiver(8, 120, 0.01);
        const setup = prepareWaterBake(river, [], ground, [], { maxRes: 128 });
        expect(Array.from(setup.kind).includes(CELL_LEAK)).toBe(true);
        const { report } = bakeWater(setup);
        expect(report.lost).toBeGreaterThan(0.5 * report.inflow);
        expect(report.lostAt).not.toBeNull();
        expect(report.lostAt![0]).toBeGreaterThan(8);                // on the downhill side
    });

    it('holds a torrent on steep ground to the speed mountain streams measure, not a smooth bed\u2019s', () => {
        const slope = 0.2;
        const river = straightRiver(8, 90, slope);
        const ground = channel(4, slope);
        const { members, report } = bakeWater(prepareWaterBake(river, [], ground, [], { maxRes: 128, manning: 0.03 }));
        const mid = at(members[0].info, 0, 50);
        const depth = mid.surface - ground(0, 50);
        expect(report.settled).toBe(true);
        expect(mid.wet).toBe(1);
        // Manning with n = 0.03 would give this depth some 6 m/s here.
        expect(Math.pow(depth, 2 / 3) * Math.sqrt(slope) / 0.03).toBeGreaterThan(4);
        expect(mid.speed).toBeGreaterThan(0.8);
        expect(mid.speed).toBeLessThan(3.5);
    });

    it('reports a hollow it could not fill in the time it had', () => {
        // A basin 6 m deep across the channel: far more water than the river brings in a minute.
        const slope = 0.02;
        const bedOf = channel(8, slope);
        const ground = (x: number, z: number) => bedOf(x, z) - 6 * Math.exp(-((z - 60) * (z - 60)) / 400);
        const river = straightRiver(16, 120, slope);
        const { report } = bakeWater(prepareWaterBake(river, [], ground, [], { maxRes: 96, settle: { maxSeconds: 60 } }));
        expect(report.settled).toBe(false);
        expect(report.filling).toBeGreaterThan(0.3 * report.inflow);
        expect(report.fillingAt).not.toBeNull();
        expect(Math.abs(report.fillingAt![1] - 60)).toBeLessThan(40);
    });

    it('carries a river\u2019s water through its lake and out down the river that drains it', () => {
        const lake = resolveWaterBody(normaliseWaterBody({ type: 'lake', depth: 3 }), { position: [0, 0, 0], scale: [2, 1, 2] }, 'lake')!;
        const reachX = (lake.max[0] - lake.min[0]) / 2;
        const inlet = resolveWaterBody(normaliseWaterBody({ type: 'river', points: [
            { pos: [-reachX - 50, 2, 0], width: 6, depth: 1, flowSpeed: 1.5 }, { pos: [-reachX - 2, 0.2, 0], width: 6, depth: 1, flowSpeed: 1.5 },
        ] }), FRAME, 'inlet', { end: lake })!;
        const outlet = resolveWaterBody(normaliseWaterBody({ type: 'river', points: [
            { pos: [reachX + 2, -0.1, 0], width: 6, depth: 1, flowSpeed: 1.5 }, { pos: [reachX + 50, -2, 0], width: 6, depth: 1, flowSpeed: 1.5 },
        ] }), FRAME, 'outlet', { start: lake })!;
        const setup = prepareWaterGroup([
            { body: inlet, into: 'lake' }, { body: lake }, { body: outlet, from: 'lake' },
        ], [], null, [], { maxRes: 160 });
        const { members, report } = bakeWater(setup);
        const [a, l, b] = members.map(m => m.info);
        expect(members.map(m => m.id)).toEqual(['inlet', 'lake', 'outlet']);
        // What the inlet brings leaves down the outlet.
        expect(report.settled).toBe(true);
        expect(report.inflow).toBeCloseTo(riverDischarge(inlet.samples[0]), 1);
        expect(Math.abs(report.outflow - report.inflow) / report.inflow).toBeLessThan(0.05);
        // The lake is not pinned to the level it was drawn at: it stands where its outlet lets it.
        const level = report.levels.find(v => v.id === 'lake')!;
        expect(level.drawn).toBe(0);
        expect(Math.abs(level.level)).toBeLessThan(1);
        // Across the lake the water runs from the mouth to the outlet, and on down the river.
        expect(at(l, 0, 0).u).toBeGreaterThan(0.005);
        expect(at(l, -reachX / 2, 0).u).toBeGreaterThan(0.005);
        expect(at(b, reachX + 30, 0).u).toBeGreaterThan(0.3);
        // Each draws its own water, and where they meet neither has a shore: the same field, cut in two.
        // The inlet's last sample is two metres inside the lake: its outline is there.
        const shore = inlet.samples.at(-1)!.x - 2;
        const inside = shore + 1.5, outside = shore - 2.5;
        expect(at(a, inside, 0).wet).toBe(0);
        expect(at(l, inside, 0).wet).toBe(1);
        expect(at(a, inside, 0).surface).toBe(at(l, inside, 0).surface);
        expect(at(l, inside, 0).edge).toBeGreaterThan(2);
        expect(at(a, outside, 0).wet).toBe(1);
        expect(at(l, outside, 0).wet).toBe(0);
        expect(at(l, outside, 0).surface).toBe(at(a, outside, 0).surface);
        expect(at(a, outside, 0).edge).toBeGreaterThan(2);
    });

    it('keeps a lake whose bed lies under the sea its own: the sea holds only what is outside the lakes', () => {
        // A crater lake 10 m over the sea, its bowl 20 m under it, draining down a river into the sea.
        const sea = resolveWaterBody(normaliseWaterBody({ type: 'ocean' }), FRAME, 'sea')!;
        const lake = resolveWaterBody(normaliseWaterBody({ type: 'lake', depth: 3 }), { position: [0, 10, 0], scale: [2, 1, 2] }, 'lake')!;
        const reachX = (lake.max[0] - lake.min[0]) / 2;
        const outlet = resolveWaterBody(normaliseWaterBody({ type: 'river', points: [
            { pos: [reachX + 2, 9.6, 0], width: 6, depth: 1, flowSpeed: 1.5 }, { pos: [reachX + 60, -1, 0], width: 6, depth: 1, flowSpeed: 1.5 },
        ] }), FRAME, 'outlet', { start: lake })!;
        const ground = (x: number, z: number) => {
            const r = Math.hypot(x, z) / reachX;
            if (r < 1) return -20 + 29 * r * r;
            if (Math.abs(z) < 4 && x > 0) return 9 - 12 * Math.min(1, (x - reachX) / 60);
            return 12;
        };
        const setup = prepareWaterGroup([{ body: lake }, { body: outlet, from: 'lake' }], [sea], ground, [], { maxRes: 160 });
        const cellAt = (x: number, z: number) => Math.round((z - setup.originZ) / setup.cell) * setup.nx + Math.round((x - setup.originX) / setup.cell);
        // The bowl's middle, 20 m under the sea, is the lake's water at the lake's level, not the sea's.
        const middle = cellAt(0, 0);
        expect(setup.kind[middle]).toBe(CELL_WATER);
        expect(setup.target[middle]).toBeCloseTo(10, 3);
        // Where the river reaches the sea, the sea holds it.
        const mouth = cellAt(reachX + 58, 0);
        expect(setup.kind[mouth]).toBe(CELL_HELD);
        expect(setup.target[mouth]).toBe(0);
    });

    it('leaves what floats no gap where one water meets the next: both reach across the mouth', () => {
        // A river into a lake and a river out of it, as nodes, baked as one and each given its bake.
        const scene = new Scene();
        const lake = new WaterVolumeNode('lake', { waterType: 'lake', depth: 3 });
        lake.setScale([2, 1, 2]);
        scene.addNode(lake); lake.updateTransforms();
        const body = lake.resolved()!;
        const reachX = (body.max[0] - body.min[0]) / 2;
        const inlet = new WaterVolumeNode('inlet', { waterType: 'river', connect: { end: lake.id }, points: [
            { pos: [-reachX - 50, 2, 0], width: 6, depth: 1, flowSpeed: 1.5 }, { pos: [-reachX - 2, 0.2, 0], width: 6, depth: 1, flowSpeed: 1.5 },
        ] });
        const outlet = new WaterVolumeNode('outlet', { waterType: 'river', connect: { start: lake.id }, points: [
            { pos: [reachX + 2, -0.1, 0], width: 6, depth: 1, flowSpeed: 1.5 }, { pos: [reachX + 50, -2, 0], width: 6, depth: 1, flowSpeed: 1.5 },
        ] });
        for (const n of [inlet, outlet]) { scene.addNode(n); n.updateTransforms(); }
        const { setup, group } = prepareGroupBake(inlet, { maxRes: 160 });
        const output = bakeWater(setup);
        forgetWaterBakeContext();
        const signature = inlet.bakeSignature();
        const ids: string[] = [];
        for (const m of output.members) {
            const node = group.find(n => n.id === m.id)!;
            const id = `seam-test:${node.name}`;
            GiBakeRegistry.set(id, encodeWaterBake(m.info, signature));
            node.bakeId = id; ids.push(id);
        }
        try {
            // Down the middle from the inlet to the outlet's end, a hand's width at a time, as the physics asks:
            // always over water, and its surface never jumps from one water to the next.
            let last = NaN, dry = 0, jump = 0;
            for (let x = -reachX - 45; x <= reachX + 45; x += 0.1) {
                const tops = [inlet, lake, outlet].map(n => n.columnAt(x, 0, 0)).filter(c => !!c).map(c => c!.surface);
                if (!tops.length) { dry++; continue; }
                const top = Math.max(...tops);
                if (last === last) jump = Math.max(jump, Math.abs(top - last));
                last = top;
            }
            expect(inlet.bakedFlowGrid()).not.toBeNull();
            expect(dry).toBe(0);
            expect(jump).toBeLessThan(0.05);
        } finally {
            for (const id of ids) GiBakeRegistry.delete(id);
        }
    });

    it('hands the lake it runs into over: not drawn by the river, and no shore there', () => {
        const lake = resolveWaterBody(normaliseWaterBody({ type: 'lake', depth: 3 }), { position: [0, -0.5, 70], scale: [1, 1, 1] }, 'lake')!;
        const river = resolveWaterBody(normaliseWaterBody({ type: 'river', points: [
            { pos: [0, 1, 0], width: 6, depth: 1, flowSpeed: 1 }, { pos: [0, 0, 55], width: 6, depth: 1, flowSpeed: 1 },
        ] }), FRAME, 'river', { end: lake })!;
        const info = bakeWater(prepareWaterBake(river, [lake], null, [], { maxRes: 96 })).members[0].info;
        // The river's last sample is two metres inside the lake.
        const shore = river.samples.at(-1)!.z - 2;
        expect(at(info, 0, 20).wet).toBe(1);
        expect(at(info, 0, shore + 1.5).wet).toBe(0);             // the lake's own node draws it
        expect(at(info, 0, shore + 1.5).edge).toBeGreaterThan(1); // water all the same
        expect(at(info, 0, shore - 2).edge).toBeGreaterThan(1);   // the river's end there is no shore
    });

    it('is deterministic: the same setup bakes the same bits', () => {
        const river = straightRiver(8, 40);
        const ground = channel(4);
        const a = bakeWater(prepareWaterBake(river, [], ground, [], { maxRes: 64, duration: 60 })).members[0].info;
        const b = bakeWater(prepareWaterBake(river, [], ground, [], { maxRes: 64, duration: 60 })).members[0].info;
        expect(Array.from(a.info0)).toEqual(Array.from(b.info0));
        const run = new ShallowWaterBake(prepareWaterBake(river, [], ground, [], { maxRes: 64, duration: 60 }));
        run.step(10);
        expect(run.progress).toBeGreaterThan(0);
        expect(run.seconds).toBeGreaterThan(0);
    });

    it('keys the ground on the saved heights under the bake, not on edits elsewhere', async () => {
        const { heightsRegionKey } = await import('../src/water/ground');
        const R = 65, size = 64;
        const u16 = new Uint16Array(R * R).map((_, i) => (i * 7919) % 65536);
        const rect = [-10, -10, 10, 10];
        const key = heightsRegionKey(u16, -5, 20, R, size, 0, 0, rect);
        expect(heightsRegionKey(u16.slice(), -5, 20, R, size, 0, 0, rect)).toBe(key);
        const far = u16.slice(); far[2] = 0;                       // a corner far outside the rectangle
        expect(heightsRegionKey(far, -5, 20, R, size, 0, 0, rect)).toBe(key);
        const under = u16.slice(); under[32 * R + 32] += 100;      // right under it
        expect(heightsRegionKey(under, -5, 20, R, size, 0, 0, rect)).not.toBe(key);
        expect(heightsRegionKey(u16, -5, 20, R, size, 500, 0, rect)).toBe('');   // the landscape is elsewhere
    });

    it('goes stale when a static obstacle moves, and bakes everything joined together, upstream first', () => {
        const scene = new Scene();
        const lake = new WaterVolumeNode('lake', { waterType: 'lake' });
        lake.setPosition([0, -1, 40]);
        const river = new WaterVolumeNode('river', { waterType: 'river' });
        river.flowsInto = lake.id;
        const stone = new ColliderNode('stone');
        stone.shapes = [{ type: 'box', width: 1, height: 3, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] } as any];
        stone.setPosition([0, 0, 0]);
        for (const n of [lake, river, stone]) { scene.addNode(n); n.updateTransforms(); }
        // The scene round a group is re-read twice a second; force it now.
        const fresh = (n: WaterVolumeNode) => { (n as any)._signature = null; forgetWaterBakeContext(); return n.bakeSignature(); };
        const before = fresh(river);
        // One bake, one signature: the lake's is the river's.
        expect(fresh(lake)).toBe(before);
        stone.setPosition([1, 0, 2]);
        stone.updateTransforms();
        expect(fresh(river)).not.toBe(before);
        expect(waterBakeGroup(lake).map(n => n.name)).toEqual(['river', 'lake']);
    });

    it('signs a bake by what it was baked from, not by how often its waters were edited', () => {
        const scene = new Scene();
        const lake = new WaterVolumeNode('lake', { waterType: 'lake' });
        lake.setPosition([0, -1, 40]);
        const river = new WaterVolumeNode('river', { waterType: 'river' });
        river.flowsInto = lake.id;
        for (const n of [lake, river]) { scene.addNode(n); n.updateTransforms(); }
        const fresh = (n: WaterVolumeNode) => { (n as any)._signature = null; forgetWaterBakeContext(); return n.bakeSignature(); };
        const before = fresh(lake);
        // Wave settings are not what the water was baked from, and editing them bumps every edit counter.
        river.windSpeed = 6; river.waveScale = 0.5; lake.windSpeed = 3; lake.choppiness = 0.9;
        expect(fresh(lake)).toBe(before);
        expect(fresh(river)).toBe(before);
        // Nor are the carve settings: the ground key says what the ground is.
        river.carve = { ...river.carve, bankWidth: river.carve.bankWidth + 2 };
        expect(fresh(river)).toBe(before);
        // The body is.
        river.points = river.points.map(p => ({ ...p, width: p.width + 1 }));
        expect(fresh(lake)).not.toBe(before);
    });

    it('ends a group at the sea: two rivers that reach the same ocean are baked apart', () => {
        const scene = new Scene();
        const sea = new WaterVolumeNode('sea', { waterType: 'ocean' });
        const east = new WaterVolumeNode('east', { waterType: 'river' });
        const west = new WaterVolumeNode('west', { waterType: 'river' });
        west.setPosition([200, 0, 0]);
        east.flowsInto = sea.id; west.flowsInto = sea.id;
        for (const n of [sea, east, west]) { scene.addNode(n); n.updateTransforms(); }
        expect(waterBakeGroup(east).map(n => n.name)).toEqual(['east']);
        expect(waterBakeGroup(west).map(n => n.name)).toEqual(['west']);
        expect(waterBakeGroup(sea)).toEqual([]);
        expect(east.bakeSignature()).not.toBe(west.bakeSignature());
    });
});
