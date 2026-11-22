import { describe, it, expect } from 'vitest';
import './helpers/features';
import { tileWaterInfo, type WaterInfo } from '../src/water/waterInfo';
import { bodySpray, flowSprayField, obstacleSpray, sampleFlow, SPRAY_FACE_SPEED } from '../src/water/spray/sprayField';
import { SPRAY_LOOK, SprayAccumulator, chooseSpray, sprayLookSystem, sprayRates, spraySource, type SprayCandidate } from '../src/water/spray/sprayParticles';
import { MAX_SPAWN_SOURCES } from '../src/particles/particleSources';
import { BUILTIN_FOAM_SPRITE, BUILTIN_MIST_SPRITE, BUILTIN_SPRAY_SPRITE } from '../src/particles/spraySprites';
import { builtinSpriteSheet, SPRITE_BORDER } from '../src/particles/precipitationSprites';
import { WaterVolumeNode } from '../src/core/scene/nodes/waterVolumeNode';

// The spray flowing water throws (water/spray/): where (rapids, falls, the faces of what stands in a fast
// current, bodies the current hits), how hard, and how a frame's worth of it is chosen and counted.

/** A grid of `n` x `n` one-metre cells, all water, its surface, depth and current given per cell. */
function river(n: number, surface: (x: number, z: number) => number, depth: (x: number, z: number) => number,
               flow: (x: number, z: number) => [number, number], wet: (x: number, z: number) => boolean = () => true): WaterInfo {
    const info0 = new Float32Array(n * n * 4), info1 = new Float32Array(n * n * 4);
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
        const i = z * n + x, [u, v] = flow(x, z), w = wet(x, z);
        info0[i * 4] = surface(x, z); info0[i * 4 + 1] = w ? u : 0; info0[i * 4 + 2] = w ? v : 0; info0[i * 4 + 3] = w ? 2 : -1;
        info1[i * 4] = 1; info1[i * 4 + 2] = surface(x, z) - depth(x, z); info1[i * 4 + 3] = w ? 1 : 0;
    }
    const info: WaterInfo = {
        originX: 0, originZ: 0, cell: 1, nx: n, nz: n, info0, info1, minY: 0, maxY: 10,
        tileCells: 0, tilesX: 0, tilesZ: 0, tileWet: new Uint8Array(0), tileMinY: new Float32Array(0), tileMaxY: new Float32Array(0),
        oceanLevel: null, source: 'test',
    };
    tileWaterInfo(info);
    return info;
}

describe('where flowing water throws spray', () => {
    it('finds a weir: its lip, the plunge at its foot, its height and how hard the water lands', () => {
        // A river 1.5 m/s along x, its surface 6 m up to x = 30 and 2 m from x = 31: a four-metre weir.
        const info = river(64, x => (x <= 30 ? 6 : 2), () => 0.5, () => [1.5, 0], (x, z) => z >= 20 && z <= 44);
        const points = flowSprayField(info);
        const lips = points.filter(p => p.kind === 'lip'), plunges = points.filter(p => p.kind === 'plunge');
        expect(lips.length).toBe(1);
        expect(plunges.length).toBe(1);
        expect(Math.abs(lips[0].x - 30)).toBeLessThanOrEqual(1);
        expect(Math.abs(plunges[0].x - 32)).toBeLessThanOrEqual(1.5);
        expect(plunges[0].height).toBeCloseTo(4, 1);
        expect(plunges[0].speed).toBeCloseTo(Math.sqrt(1.5 ** 2 + 2 * 9.81 * 4), 1);
        // A sheer drop is a curtain too, falling its whole height.
        const curtain = points.find(p => p.kind === 'curtain')!;
        expect(curtain).toBeTruthy();
        expect(curtain.rise).toBeCloseTo(4, 1);
        // Its spray: droplets off the plunge (the fall's power), and mist only a fall over two metres makes.
        expect(sprayRates(plunges[0]).droplets).toBeGreaterThan(100);
        expect(sprayRates(plunges[0]).mist).toBeGreaterThan(0);
        // The same grid gives the same points.
        expect(flowSprayField(info).map(p => p.id)).toEqual(points.map(p => p.id));
    });

    it('takes a long steep chute for rapids all the way down, not a fall with its foot halfway', () => {
        // Falling 0.6 m a metre for 60 m, a step at its head: no flattening within reach, so no plunge.
        const info = river(64, x => (x < 2 ? 40 : 40 - 0.6 * (x - 2)), () => 0.3, () => [2.5, 0], (x, z) => z >= 28 && z <= 36);
        const kinds = new Set(flowSprayField(info).map(p => p.kind));
        expect(kinds.has('plunge')).toBe(false);
    });

    it('throws nothing off still water or a gentle river', () => {
        expect(flowSprayField(river(32, () => 1, () => 1, () => [0, 0]))).toEqual([]);
        expect(flowSprayField(river(32, x => 5 - 0.001 * x, () => 1, () => [1, 0]))).toEqual([]);
    });

    it('finds the rapid where fast water jumps up and slows', () => {
        // 4 m/s and 0.4 m deep up to x = 16, then 1 m/s and 1.6 m deep: a hydraulic jump losing its head.
        const info = river(32, x => (x <= 16 ? 1 : 1.6), x => (x <= 16 ? 0.4 : 1.6), x => [x <= 16 ? 4 : 1, 0]);
        const rapids = flowSprayField(info).filter(p => p.kind === 'rapid');
        expect(rapids.length).toBeGreaterThan(0);
        for (const r of rapids) expect(Math.abs(r.x - 16.5)).toBeLessThan(4);
    });

    it('bursts up the face fast water meets on a post, as high as the water piles', () => {
        const fast = river(64, () => 1, () => 1, () => [3, 0]);
        const post = { x: 32, z: 32, ax: 1, az: 0, a: 0, b: 0, r: 0.3, under: 0 };
        const faces = obstacleSpray([post], (x, z, out) => sampleFlow(fast, x, z, out), 1);
        expect(faces.length).toBe(1);
        expect(faces[0].x).toBeCloseTo(32 - 0.3, 5);
        expect(faces[0].height).toBeCloseTo(9 / (2 * 9.81), 3);
        const slow = river(64, () => 1, () => 1, () => [SPRAY_FACE_SPEED / 2, 0]);
        expect(obstacleSpray([post], (x, z, out) => sampleFlow(slow, x, z, out), 1)).toEqual([]);
        // A rock deep under the water throws nothing.
        expect(obstacleSpray([{ ...post, under: 0.6 }], (x, z, out) => sampleFlow(fast, x, z, out), 1)).toEqual([]);
    });

    it('throws spray off a body the current runs at, and splashes one dropped in', () => {
        const held = bodySpray([{ x: 0, z: 0, radius: 0.5, share: 1, vx: -3, vy: 0, vz: 0 }], () => 1);
        expect(held.length).toBe(1);
        expect(held[0].kind).toBe('body');
        expect(held[0].x).toBeCloseTo(-0.5, 6);   // the face upstream, the water coming at it
        expect(bodySpray([{ x: 0, z: 0, radius: 0.5, share: 1, vx: -1, vy: 0, vz: 0 }], () => 1)).toEqual([]);
        const dropped = bodySpray([{ x: 0, z: 0, radius: 0.5, share: 1, vx: 0, vy: -5, vz: 0 }], () => 1);
        expect(dropped.map(p => p.kind)).toEqual(['entry']);
        expect(spraySource(dropped[0], 'droplets', 10).vy).toBeGreaterThan(1);
        // Nowhere to stand on: none.
        expect(bodySpray([{ x: 0, z: 0, radius: 0.5, share: 1, vx: -3, vy: 0, vz: 0 }], () => null)).toEqual([]);
    });
});

describe('a frame of spray', () => {
    const at = (id: number, x: number, rate: number): SprayCandidate => ({
        point: { id, kind: 'rapid', x, y: 0, z: 0, ax: 1, az: 0, along: 1, across: 1, rise: 0, ux: 1, uz: 0, speed: 1, power: 1, height: 0, q: 0 },
        rate,
    });

    it('feeds the most important points near the camera, within the budget, the same way every time', () => {
        const all = Array.from({ length: 80 }, (_, i) => at(i, i, 100 + (i % 7) * 10));
        const a = chooseSpray(all, [0, 0, 0], [1, 0, 0], 70, 2000, new Set());
        const b = chooseSpray(all, [0, 0, 0], [1, 0, 0], 70, 2000, new Set());
        expect(a.length).toBe(MAX_SPAWN_SOURCES);
        expect(a.map(c => c.point.id)).toEqual(b.map(c => c.point.id));
        expect(a.reduce((s, c) => s + c.rate, 0)).toBeLessThanOrEqual(2000 + 1e-6);
        for (const c of a) expect(c.point.x).toBeLessThan(70);
        // Behind the camera, and far: not fed.
        expect(chooseSpray([at(1, -40, 100)], [0, 0, 0], [1, 0, 0], 70, 2000, new Set())).toEqual([]);
        // The ones fed last frame are favoured over a hair more important newcomer.
        const kept = chooseSpray([at(1, 5, 100), at(2, 5, 101)].concat(Array.from({ length: 31 }, (_, i) => at(10 + i, 5, 500))),
                                 [0, 0, 0], [1, 0, 0], 70, 1e9, new Set([1]));
        expect(kept.map(c => c.point.id)).toContain(1);
    });

    it('feeds what a body does to the water ahead of the river’s own rapids', () => {
        const rapids = Array.from({ length: 40 }, (_, i) => at(i, 5, 180));
        const body: SprayCandidate = { point: { ...rapids[0].point, id: 999, kind: 'body' }, rate: 50 };
        expect(chooseSpray([...rapids, body], [0, 0, 0], [1, 0, 0], 70, 1e9, new Set()).map(c => c.point.id)).toContain(999);
    });

    it('counts whole particles exactly, carrying each point’s fraction', () => {
        const acc = new SprayAccumulator();
        let total = 0;
        for (let f = 0; f < 60 * 60; f++) { acc.advance(1 / 60); total += acc.take(7, 2.5, 1 / 60); }
        expect(total).toBeGreaterThanOrEqual(149);
        expect(total).toBeLessThanOrEqual(150);
        // A point not seen for a second is forgotten.
        for (let f = 0; f < 70; f++) acc.advance(1 / 60);
        expect(acc.size).toBe(0);
    });

    it('draws each look with a sources emitter in world space and the engine’s own sprites', () => {
        for (const look of ['droplets', 'mist', 'foam'] as const) {
            const def = sprayLookSystem(look);
            const e = def.emitters[0];
            expect(e.simSpace).toBe('world');
            expect(e.capacity).toBe(SPRAY_LOOK[look].capacity);
            expect(e.init.find(m => m.type === 'shape')!.params.shape).toBe('sources');
        }
        for (const id of [BUILTIN_SPRAY_SPRITE, BUILTIN_MIST_SPRITE, BUILTIN_FOAM_SPRITE]) {
            const sheet = builtinSpriteSheet(id)!;
            expect(sheet).not.toBeNull();
            // Every cell has something in it, and its border is clear.
            const cw = sheet.width / sheet.columns, ch = sheet.height / sheet.rows;
            for (let c = 0; c < sheet.frames; c++) {
                const ox = (c % sheet.columns) * cw, oy = Math.floor(c / sheet.columns) * ch;
                let sum = 0, border = 0;
                for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
                    const a = sheet.pixels[((oy + y) * sheet.width + ox + x) * 4 + 3];
                    sum += a;
                    if (x < SPRITE_BORDER || y < SPRITE_BORDER || x >= cw - SPRITE_BORDER || y >= ch - SPRITE_BORDER) border += a;
                }
                expect(sum).toBeGreaterThan(0);
                expect(border).toBe(0);
            }
        }
    });

    it('keeps a water’s Spray amount, saved only when not the default', async () => {
        const w = new WaterVolumeNode('w', { waterType: 'river' });
        expect(w.spray).toBe(1);
        expect((await w.serialize() as any).waterVolume.spray).toBeUndefined();
        w.spray = 5;
        expect(w.spray).toBe(2);
        w.spray = 0.4;
        expect((await w.serialize() as any).waterVolume.spray).toBe(0.4);
        expect(new WaterVolumeNode('w2', { spray: -1 }).spray).toBe(0);
    });
});
