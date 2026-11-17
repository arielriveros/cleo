import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import './helpers/features';
import { Scene } from '../src/core/scene/scene';
import { WaterVolumeNode } from '../src/core/scene/nodes/waterVolumeNode';
import { ColliderNode } from '../src/core/scene/nodes/colliderNode';
import { normaliseWaterBody, resolveWaterBody } from '../src/water/waterShapes';
import { bakeWater, prepareWaterBake, ShallowWaterBake, CELL_WALL } from '../src/water/bake/shallowWater';
import { sceneObstacles, obstacleSpan } from '../src/water/bake/obstacles';
import { waterBakeGroup } from '../src/water/bake/bakeNode';
import type { WaterInfo } from '../src/water/waterInfo';

// The river flow bake (water/bake/): the shallow-water equations over the body, the ground and the static
// obstacles in it. Water must go round a rock that stands out of it and speed over one under it, settle a
// river at the speed Manning's friction gives its slope, carry a river's discharge into its lake, and come
// out the same every time.

const FRAME = { position: [0, 0, 0], scale: [1, 1, 1] };
const SLOPE = 0.002;
/** An inclined plane: the bed falls SLOPE per metre toward +z. */
const ground = (_x: number, z: number) => -SLOPE * z;

/** A straight river down the plane, `width` wide, from z = 0 to z = `length`. */
function straightRiver(width: number, length: number, speed = 1) {
    const points = [0, length / 2, length].map(z => ({ pos: [0, ground(0, z) + 1, z] as [number, number, number], width, depth: 1, flowSpeed: speed }));
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
    return { surface: info.info0[i * 4], u: info.info0[i * 4 + 1], v: info.info0[i * 4 + 2], wet: info.info1[i * 4 + 3], speed: Math.hypot(info.info0[i * 4 + 1], info.info0[i * 4 + 2]) };
};

describe('the river flow bake', { timeout: 60000 }, () => {
    it('finds where a static box stands and how far up it reaches', () => {
        const [o] = sceneObstacles([rock(0, 1, 0, 2, 4, 2)]);
        const span = obstacleSpan(o, 0.3, -0.4)!;
        expect(span[0]).toBeCloseTo(-1, 1);
        expect(span[1]).toBeCloseTo(3, 1);
        expect(obstacleSpan(o, 1.5, 0)).toBeNull();
        // A dynamic collider is no obstacle.
        expect(sceneObstacles([{ ...rock(0, 1, 0, 2, 4, 2), mass: 5 }])).toEqual([]);
    });

    it('settles a river at the speed Manning gives its slope and depth', () => {
        const river = straightRiver(30, 200);
        const setup = prepareWaterBake(river, [], ground, [], { maxRes: 128, duration: 300, manning: 0.03 });
        const info = bakeWater(setup);
        // Upstream of the outfall's drawdown (the water speeds up and thins before a free drop, as a real
        // channel's does), where the flow is uniform.
        const mid = at(info, 0, 50);
        const depth = mid.surface - ground(0, 50);
        const manning = Math.pow(depth, 2 / 3) * Math.sqrt(SLOPE) / 0.03;
        expect(mid.v).toBeGreaterThan(0.2);                          // downstream
        expect(Math.abs(mid.speed - manning) / manning).toBeLessThan(0.1);
    });

    it('goes round a rock standing out of the water, faster beside it than above it', () => {
        const river = straightRiver(12, 80);
        const obstacles = sceneObstacles([rock(0, ground(0, 40) + 1, 40, 3, 6, 3)]);
        const setup = prepareWaterBake(river, [], ground, obstacles, { maxRes: 160, duration: 160 });
        const centre = Math.round((40 - setup.originZ) / setup.cell) * setup.nx + Math.round((0 - setup.originX) / setup.cell);
        expect(setup.kind[centre]).toBe(CELL_WALL);
        const info = bakeWater(setup);
        expect(at(info, 0, 40).wet).toBe(0);
        const beside = (at(info, 3, 40).speed + at(info, -3, 40).speed) / 2;
        const upstream = (at(info, 3, 20).speed + at(info, -3, 20).speed) / 2;
        expect(beside).toBeGreaterThan(upstream);
    });

    it('speeds up over a rock under the water', () => {
        const river = straightRiver(10, 80);
        const obstacles = sceneObstacles([rock(0, ground(0, 40) - 0.2, 40, 4, 0.8, 4)]);
        const info = bakeWater(prepareWaterBake(river, [], ground, obstacles, { maxRes: 160, duration: 160 }));
        expect(at(info, 0, 40).wet).toBe(1);
        expect(at(info, 0, 40).speed).toBeGreaterThan(at(info, 0, 20).speed);
    });

    it('carries a river’s discharge into its lake and out through the river that drains it', () => {
        const lake = resolveWaterBody(normaliseWaterBody({ type: 'lake', depth: 3 }), { position: [0, 0, 0], scale: [2, 1, 2] }, 'lake')!;
        const setup = prepareWaterBake(lake, [], null, [], {
            maxRes: 96, duration: 120,
            inflows: [{ x: -20, z: 0, radius: 3, discharge: 6 }], outflows: [{ x: 20, z: 0, radius: 3 }],
        });
        const info = bakeWater(setup);
        // Between the mouth and the outlet the water runs from one to the other.
        expect(at(info, 0, 0).u).toBeGreaterThan(0.01);
        expect(at(info, -12, 0).u).toBeGreaterThan(0.01);
    });

    it('hands the lake it runs into over: not drawn by the river, and no shore there', () => {
        const lake = resolveWaterBody(normaliseWaterBody({ type: 'lake', depth: 3 }), { position: [0, -0.5, 70], scale: [1, 1, 1] }, 'lake')!;
        const river = resolveWaterBody(normaliseWaterBody({ type: 'river', points: [
            { pos: [0, 1, 0], width: 6, depth: 1, flowSpeed: 1 }, { pos: [0, 0, 55], width: 6, depth: 1, flowSpeed: 1 },
        ] }), FRAME, 'river', { end: lake })!;
        const info = bakeWater(prepareWaterBake(river, [lake], null, [], { maxRes: 96, duration: 60 }));
        expect(at(info, 0, 20).wet).toBe(1);
        expect(at(info, 0, 66).wet).toBe(0);                      // the lake's own node draws it
        const i = Math.round((60 - info.originZ) / info.cell) * info.nx + Math.round((0 - info.originX) / info.cell);
        expect(info.info0[i * 4 + 3]).toBeGreaterThan(1);        // the river's end there is no shore
    });

    it('is deterministic: the same setup bakes the same bits', () => {
        const river = straightRiver(8, 40);
        const a = bakeWater(prepareWaterBake(river, [], ground, [], { maxRes: 64, duration: 30 }));
        const b = bakeWater(prepareWaterBake(river, [], ground, [], { maxRes: 64, duration: 30 }));
        expect(Array.from(a.info0)).toEqual(Array.from(b.info0));
        const run = new ShallowWaterBake(prepareWaterBake(river, [], ground, [], { maxRes: 64, duration: 30 }));
        run.step(10);
        expect(run.progress).toBeGreaterThan(0);
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

    it('goes stale when a static obstacle moves, and bakes a group upstream first', () => {
        const scene = new Scene();
        const lake = new WaterVolumeNode('lake', { waterType: 'lake' });
        lake.setPosition([0, -1, 40]);
        const river = new WaterVolumeNode('river', { waterType: 'river' });
        river.flowsInto = lake.id;
        const stone = new ColliderNode('stone');
        stone.shapes = [{ type: 'box', width: 1, height: 3, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] } as any];
        stone.setPosition([0, 0, 0]);
        for (const n of [lake, river, stone]) { scene.addNode(n); n.updateTransforms(); }
        const before = river.bakeSignature();
        stone.setPosition([1, 0, 2]);
        stone.updateTransforms();
        (river as any)._signature = null;   // the scene around it is re-read twice a second; force it now
        expect(river.bakeSignature()).not.toBe(before);
        expect(waterBakeGroup(lake).map(n => n.name)).toEqual(['river', 'lake']);
    });
});
