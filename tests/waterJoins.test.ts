import { describe, it, expect } from 'vitest';
import './helpers/features';
import { Scene } from '../src/core/scene/scene';
import { WaterVolumeNode } from '../src/core/scene/nodes/waterVolumeNode';
import { waterJoinField, type JoinSample, type WaterEdges } from '../src/water/waterEdges';
import { tileWaterInfo, type WaterInfo } from '../src/water/waterInfo';
import { waterSpecColumn } from '../src/physics/waterSurface';
import { JOIN_CHANNELS, JOIN_FAR, joinLength, joinWeight, sampleJoin, seaUnderRiver } from '../src/physics/water/joins';

// Where a river runs into the water it joins: over a band upstream of the seam the river takes on that water's
// surface (its resting height and its waves), all of it at the seam, so the two meet as one surface; the water
// joined keeps its own. Physics floats on the same blend the surface draws (water.wgsl, the join slots).

/** Water nodes in one scene, so their connections find each other, their world transforms current. */
function sceneOf(...nodes: WaterVolumeNode[]): Scene {
    const scene = new Scene();
    for (const n of nodes) { scene.addNode(n); n.updateTransforms(); }
    return scene;
}

/** A lake with wind waves at z = 30 and a river with its current's waves running into it from upstream. */
function riverIntoLake() {
    const lake = new WaterVolumeNode('lake', { waterType: 'lake', windSpeed: 9, fetch: 3000, waveAmplitude: 0 });
    lake.setPosition([0, 0, 30]);
    const river = new WaterVolumeNode('river', { waterType: 'river', waveAmplitude: 0, points: [
        { pos: [0, 2, -10], width: 4, depth: 1, flowSpeed: 1.5 }, { pos: [0, 0.2, 20], width: 4, depth: 1, flowSpeed: 1.5 },
    ] });
    river.flowsInto = lake.id;
    sceneOf(lake, river);
    return { lake, river };
}

/** The join field's seam distance at (x, z) (positive on the river's side). */
function seamAt(river: WaterVolumeNode, x: number, z: number): number {
    const out = new Float32Array(JOIN_CHANNELS);
    sampleJoin(river.waterJoin()!.field, x, z, out);
    return out[0];
}

/** The z along the line x (the river's centre line: 0) where its seam with the water it joins is. */
function seamZ(river: WaterVolumeNode, from: number, to: number, x = 0): number {
    let a = from, b = to;
    expect(seamAt(river, x, a)).toBeGreaterThan(0);
    expect(seamAt(river, x, b)).toBeLessThanOrEqual(0);
    for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (seamAt(river, x, m) > 0) a = m; else b = m; }
    return (a + b) / 2;
}

describe('a river meeting the water it joins', () => {
    it('finds the mouth where the river is handed over to its lake, with a band half again its width', () => {
        const { lake, river } = riverIntoLake();
        const join = river.waterJoin()!;
        expect(join).not.toBeNull();
        expect(join.targets.map(t => t.node)).toEqual([lake]);
        expect(join.targets[0].length).toBeCloseTo(joinLength(4, 40), 6);
        expect(join.field.bounds[0]).not.toBeNull();
        // The seam is where the lake begins (its outline crosses the river near z = 22 to 23).
        const z = seamZ(river, 10, 26);
        expect(z).toBeGreaterThan(20.5);
        expect(z).toBeLessThan(24);
        // Far upstream nothing is joined.
        expect(seamAt(river, 0, -5)).toBeGreaterThan(join.targets[0].length);
        // The distance is a true one: a metre further up, a metre more.
        expect(seamAt(river, 0, z - 3) - seamAt(river, 0, z - 2)).toBeCloseTo(1, 1);
        // Other water has no mouths.
        expect(lake.waterJoin()).toBeNull();
    });

    it('stands on the lake surface, waves and all, at the seam, and is its own beyond the band', () => {
        const { lake, river } = riverIntoLake();
        const z = seamZ(river, 10, 26);
        const band = river.waterJoin()!.targets[0].length;
        let joined = 0, apart = 0;
        for (const t of [0.3, 1.7, 4.1, 9.6, 13.2, 21.7]) {
            for (const x of [-0.8, 0, 0.9]) {
                const zx = seamZ(river, 10, 26, x);
                const r = river.columnAt(x, zx - 0.01, t)!, l = lake.columnAt(x, zx + 0.01, t)!;
                expect(l).not.toBeNull();
                joined = Math.max(joined, Math.abs(r.surface - l.surface));
                // The river on its own (no water to look the lake up in) would stand apart from it there.
                const alone = waterSpecColumn(river.buoyancySpec(), x, zx - 0.01, t)!;
                apart = Math.max(apart, Math.abs(alone.surface - l.surface));
            }
        }
        expect(joined).toBeLessThan(0.004);
        expect(apart).toBeGreaterThan(0.015);
        // The lake's waves really are there (it is not calm), and the river upstream of the band is its own.
        const heights = [0.3, 1.7, 4.1, 9.6].map(t => lake.columnAt(0, z + 1, t)!.surface);
        expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.03);
        for (const t of [0.4, 2.5, 6.1]) {
            const own = river.columnAt(0, z - band - 1, t)!;
            const alone = waterSpecColumn(river.buoyancySpec(), 0, z - band - 1, t)!;
            expect(own.surface).toBeCloseTo(alone.surface, 9);
        }
    });

    it('gives a float drifting through the mouth a surface without a step', () => {
        const { lake, river } = riverIntoLake();
        const z0 = seamZ(river, 10, 26);
        // What the buoyancy solver reads: the river's water up to the seam, the lake's past it (it gives way
        // there, the two being at one level).
        const time = 3.3;
        const surfaceAt = (z: number) => {
            const r = river.columnAt(0, z, time), l = lake.columnAt(0, z, time);
            if (r && l && (l.rest ?? l.surface) >= (r.rest ?? r.surface) - 0.05) return l.surface;
            return (r ?? l)!.surface;
        };
        let last = surfaceAt(z0 - 14);
        for (let z = z0 - 14; z < z0 + 4; z += 0.05) {
            const s = surfaceAt(z);
            expect(Math.abs(s - last)).toBeLessThan(0.03);
            last = s;
        }
    });

    it('takes on nothing where it falls into the water it joins rather than meeting it', () => {
        // A grid of 20 x 20 one-metre cells: the river's own water for z < 10, the joined water's past it.
        const nx = 20, nz = 20, n = nx * nz;
        const info: WaterInfo = {
            originX: 0, originZ: 0, cell: 1, nx, nz, info0: new Float32Array(n * 4), info1: new Float32Array(n * 4),
            minY: 0, maxY: 3, tileCells: 0, tilesX: 0, tilesZ: 0, tileWet: new Uint8Array(0), tileMinY: new Float32Array(0),
            tileMaxY: new Float32Array(0), oceanLevel: null, source: 'test',
        };
        const owner = new Int8Array(n).fill(-1);
        const edges: WaterEdges = { surface: new Float32Array(n), shore: new Float32Array(n).fill(5), draw: new Float32Array(n), tileDrawn: new Uint8Array(0) };
        for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
            const i = z * nx + x;
            const mine = z < 10;
            info.info1[i * 4 + 3] = mine ? 1 : 0;
            info.info0[i * 4 + 3] = 5;
            if (!mine) owner[i] = 0;
            edges.draw[i] = mine ? 10 - z - 0.5 : -(z - 10 + 0.5);
            edges.surface[i] = 3;
        }
        tileWaterInfo(info);
        const atLevel = (rest: number) => (_k: number, _x: number, _z: number, out: JoinSample) => {
            out.rest = rest; out.edge = 4; out.depth = JOIN_FAR; out.ux = 0; out.uz = 0;
        };
        // Meeting it within a step: a band 6 m up from the seam half way between rows 9 and 10.
        const met = waterJoinField(info, edges, { owner, lengths: [6], at: atLevel(2.6) })!;
        expect(met).not.toBeNull();
        const s = new Float32Array(JOIN_CHANNELS);
        sampleJoin(met, 10, 9.5, s);
        expect(Math.abs(s[0])).toBeLessThan(1e-3);
        sampleJoin(met, 10, 5.5, s);
        expect(s[0]).toBeCloseTo(4, 3);
        expect(s[1]).toBeCloseTo(-0.4, 5);   // the joined water stands 0.4 m below the river
        expect(s[2]).toBeCloseTo(4, 5);
        sampleJoin(met, 10, 0, s);
        expect(s[0]).toBeGreaterThan(6);     // past the band
        // Three metres below it: a waterfall, no mouth.
        expect(waterJoinField(info, edges, { owner, lengths: [6], at: atLevel(0) })).toBeNull();
    });

    it('weighs the river toward the joined water smoothly, all of it at the seam, none past the band', () => {
        expect(joinWeight(0, 8)).toBe(1);
        expect(joinWeight(-1, 8)).toBe(1);
        expect(joinWeight(8, 8)).toBe(0);
        expect(joinWeight(20, 8)).toBe(0);
        let last = 1;
        for (let s = 0.1; s < 8; s += 0.1) { const w = joinWeight(s, 8); expect(w).toBeLessThanOrEqual(last + 1e-12); last = w; }
        expect(joinLength(2)).toBe(4);
        expect(joinLength(40)).toBe(24);
        expect(joinLength(10, 20)).toBeCloseTo(8, 9);
    });

    it('takes the sea under a river down, but not at its mouth or beside it', () => {
        const under = { slot: 1, length: 10 };
        expect(seaUnderRiver(5, -3, 1, under)).toBe(1);       // outside the river: the sea
        expect(seaUnderRiver(20, 3, 1, under)).toBe(0);       // under the river upstream: none of it
        expect(seaUnderRiver(0, 3, 1, under)).toBe(1);        // at the seam: all of it
        expect(seaUnderRiver(0, 3, 0, under)).toBe(0);        // the river's other mouth: none
        expect(seaUnderRiver(5, 3, 1, under)).toBeCloseTo(0.5, 6);
    });

    it('meets the sea it runs into as one surface, and the sea under it upstream is not there', () => {
        const sea = new WaterVolumeNode('sea', { waterType: 'ocean', windSpeed: 10, waveAmplitude: 0 });
        const river = new WaterVolumeNode('river', { waterType: 'river', waveAmplitude: 0, points: [
            { pos: [0, 6, -80], width: 10, depth: 2, flowSpeed: 2 }, { pos: [0, 0, 40], width: 10, depth: 2, flowSpeed: 2 },
        ] });
        river.flowsInto = sea.id;
        sceneOf(sea, river);
        const join = river.waterJoin()!;
        expect(join).not.toBeNull();
        const z = seamZ(river, 0, 40);
        for (const t of [0.5, 2.2, 7.9]) {
            const r = river.columnAt(0, z - 0.02, t)!, s = sea.columnAt(0, z + 0.02, t)!;
            expect(s).not.toBeNull();
            expect(Math.abs(r.surface - s.surface)).toBeLessThan(0.03);
        }
        // Upstream, under the river, the sea gives way to it.
        expect(sea.columnAt(0, z - join.targets[0].length - 5, 1)).toBeNull();
        // Beside the river (no landscape: the sea is everywhere else) it is the sea.
        expect(sea.columnAt(40, -60, 1)).not.toBeNull();
    });

    it('meets the river it runs into as one surface, that river\'s current-borne waves and all', () => {
        const main = new WaterVolumeNode('main', { waterType: 'river', waveAmplitude: 0, points: [
            { pos: [-40, 0, 0], width: 8, depth: 2, flowSpeed: 2.5 }, { pos: [40, -2, 0], width: 8, depth: 2, flowSpeed: 2.5 },
        ] });
        const trib = new WaterVolumeNode('trib', { waterType: 'river', waveAmplitude: 0, points: [
            { pos: [0, 4, 40], width: 3, depth: 1, flowSpeed: 1.5 }, { pos: [0, 3, 0], width: 3, depth: 1, flowSpeed: 1.5 },
        ] });
        trib.flowsInto = main.id;
        sceneOf(trib, main);
        const join = trib.waterJoin()!;
        expect(join).not.toBeNull();
        expect(join.targets[0].node).toBe(main);
        // Coming in from +z: the seam is the main river's bank, near z = 4.
        const z = seamZ(trib, 20, -1);
        expect(z).toBeGreaterThan(2.5);
        expect(z).toBeLessThan(5.5);
        let joined = 0;
        for (const t of [0.6, 3.1, 8.4, 15.2]) {
            const r = trib.columnAt(0, z + 0.01, t)!, m = main.columnAt(0, z - 0.01, t)!;
            expect(m).not.toBeNull();
            joined = Math.max(joined, Math.abs(r.surface - m.surface));
        }
        expect(joined).toBeLessThan(0.01);
    });
});
