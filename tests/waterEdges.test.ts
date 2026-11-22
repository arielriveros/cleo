import { describe, it, expect } from 'vitest';
import { clipMargin, clipWaterToShape, refineWaterEdges, seamOverlap, EDGE_APRON_CELLS } from '../src/water/waterEdges';
import { chamferDistance, tileWaterInfo, type WaterInfo } from '../src/water/waterInfo';

// Where a water ends, finer than its grid (water/waterEdges.ts; render/water.ts draws with it). The surface
// shader cuts where the filtered draw distance crosses nought, so what is held to account here is that line,
// read off the grid the way a linear filter reads it: on the true edge to a small fraction of a cell, where the
// wet flag's own outline was off by up to half a cell, in a staircase.

/** A grid of `n` × `n` cells of `cell` metres from the origin, wet where `wet` says, at `surface`, over `ground`. */
function grid(n: number, cell: number, wet: (x: number, z: number) => boolean, surface: (x: number, z: number) => number,
              ground: (x: number, z: number) => number, other: (x: number, z: number) => boolean = () => false): WaterInfo {
    const info0 = new Float32Array(n * n * 4), info1 = new Float32Array(n * n * 4);
    const mask = new Uint8Array(n * n), sys = new Uint8Array(n * n);
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
        const i = z * n + x, wx = x * cell, wz = z * cell;
        mask[i] = wet(wx, wz) ? 1 : 0;
        sys[i] = mask[i] || other(wx, wz) ? 1 : 0;
        info0[i * 4] = surface(wx, wz);
        info1[i * 4 + 2] = ground(wx, wz);
        info1[i * 4 + 3] = mask[i];
        info1[i * 4] = 1;
    }
    // As the builders do: the shore distance over all the system's water, a dry cell's surface its nearest
    // water's (the bake's own pushes it under the ground; the refinement must not care).
    const { dist } = chamferDistance(sys, n, n, cell);
    for (let i = 0; i < n * n; i++) info0[i * 4 + 3] = dist[i];
    const info: WaterInfo = {
        originX: 0, originZ: 0, cell, nx: n, nz: n, info0, info1, minY: 0, maxY: 0,
        tileCells: 0, tilesX: 0, tilesZ: 0, tileWet: new Uint8Array(0), tileMinY: new Float32Array(0), tileMaxY: new Float32Array(0),
        oceanLevel: null, source: 'test',
    };
    tileWaterInfo(info);
    return info;
}

/** `field` at world (x, z), filtered linearly between cell centres as the GPU does. */
function sample(field: Float32Array, n: number, cell: number, x: number, z: number): number {
    const fx = x / cell, fz = z / cell;
    const x0 = Math.max(0, Math.min(n - 2, Math.floor(fx))), z0 = Math.max(0, Math.min(n - 2, Math.floor(fz)));
    const tx = fx - x0, tz = fz - z0;
    const at = (a: number, b: number) => field[(z0 + b) * n + x0 + a];
    return (at(0, 0) * (1 - tx) + at(1, 0) * tx) * (1 - tz) + (at(0, 1) * (1 - tx) + at(1, 1) * tx) * tz;
}

/** Where along the line from p (inside) to q (outside) `field` crosses nought, bisected. */
function zeroBetween(field: Float32Array, n: number, cell: number, p: number[], q: number[]): number[] {
    let a = p, b = q;
    for (let k = 0; k < 40; k++) {
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (sample(field, n, cell, m[0], m[1]) > 0) a = m; else b = m;
    }
    return a;
}

describe('where a water ends', () => {
    const n = 48, cell = 1;
    // A straight edge at 30 degrees to the grid: inside where the signed distance is positive.
    const angle = Math.PI / 6;
    const nx = Math.cos(angle), nz = Math.sin(angle), c = 0.5 * n * (nx + nz) * cell;
    const signed = (x: number, z: number) => c - (x * nx + z * nz);

    it('cuts a drawn edge across the grid on the edge itself, not on the cells', () => {
        // An unbaked water over low ground (no bank to hide its edge): it ends where its shape does.
        const info = grid(n, cell, (x, z) => signed(x, z) > 0, () => 1, () => -3);
        const edges = refineWaterEdges(info, { shapeEdge: signed, ground: () => -3 });
        const wet = new Float32Array(n * n);
        for (let i = 0; i < n * n; i++) wet[i] = info.info1[i * 4 + 3] - 0.5;
        let worst = 0, worstOld = 0;
        for (let s = -10; s <= 10; s += 0.37) {
            // A point on the true edge, and a probe across it.
            const ex = c * nx - s * nz, ez = c * nz + s * nx;
            const p = [ex - 2 * nx, ez - 2 * nz], q = [ex + 2 * nx, ez + 2 * nz];
            const at = zeroBetween(edges.draw, n, cell, p, q);
            worst = Math.max(worst, Math.abs(signed(at[0], at[1])));
            const old = zeroBetween(wet, n, cell, p, q);
            worstOld = Math.max(worstOld, Math.abs(signed(old[0], old[1])));
        }
        expect(worst).toBeLessThan(0.05 * cell);
        // What it replaces: the wet flag's outline, a staircase up to half a cell off.
        expect(worstOld).toBeGreaterThan(0.25 * cell);
    });

    it('carries the surface on level under a bank, and draws it there for the ground to cut', () => {
        // Ground rising out of the water along x: the waterline is where it reaches the surface (x = 24.4).
        const level = 2, slope = 0.25, shoreX = 24.4;
        const ground = (x: number) => level + (x - shoreX) * slope;
        // The bake's kind of grid: dry past a film, its dry cells' surface pushed under the ground.
        const info = grid(n, cell, x => level - ground(x) > 0.03, x => (level - ground(x) > 0.03 ? level : ground(x) - 0.03), x => ground(x));
        const edges = refineWaterEdges(info, { baked: true, ground: x => ground(x) });
        for (let z = 2; z < n - 2; z++) for (let x = 0; x < n; x++) {
            const i = z * n + x;
            expect(edges.surface[i]).toBeCloseTo(level, 5);
            // Drawn on a couple of cells under the bank (the landscape's depth test draws the waterline there).
            if (x * cell < shoreX + EDGE_APRON_CELLS * cell - 0.5) expect(edges.draw[i]).toBeGreaterThan(0);
        }
        // The shore is where the ground meets the water, between the cells.
        const at = zeroBetween(edges.shore, n, cell, [shoreX - 3, 20], [shoreX + 3, 20]);
        expect(Math.abs(at[0] - shoreX)).toBeLessThan(0.05 * cell);
    });

    it('ends a water over a drop on a line, level to its edge', () => {
        // Baked water whose ground falls away past its last cells: never drawn sloping down to that ground.
        const info = grid(n, cell, (x, z) => signed(x, z) > 0, (x, z) => (signed(x, z) > 0 ? 3 : -6.03), (x, z) => (signed(x, z) > 0 ? 1 : -6));
        const edges = refineWaterEdges(info, { baked: true, ground: (x, z) => (signed(x, z) > 0 ? 1 : -6) });
        for (let i = 0; i < n * n; i++) expect(edges.surface[i]).toBe(3);
        // Cut between the cells (on the bake's smoothed outline): within half a cell of the edge, never a cell off.
        const p = [c * nx - 2 * nx, c * nz - 2 * nz], q = [c * nx + 2 * nx, c * nz + 2 * nz];
        const at = zeroBetween(edges.draw, n, cell, p, q);
        expect(Math.abs(signed(at[0], at[1]))).toBeLessThan(0.6 * cell);
        expect(sample(edges.draw, n, cell, c * nx + 2 * nx, c * nz + 2 * nz)).toBeLessThan(0);
    });

    it('keeps a stream one cell wide', () => {
        const info = grid(n, cell, (x, z) => z === 20, () => 1, (x, z) => (z === 20 ? 0 : -4));
        const edges = refineWaterEdges(info, { baked: true, ground: (x, z) => (z === 20 ? 0 : -4) });
        for (let x = 2; x < n - 2; x++) expect(edges.draw[20 * n + x]).toBeGreaterThan(0);
        expect(edges.draw[22 * n + 10]).toBeLessThan(0);
    });

    it('draws over a dry speck inside the water: a post hides it, no hole opens round it', () => {
        const speck = (x: number, z: number) => x === 20 && z === 20;
        const info = grid(n, cell, (x, z) => x > 4 && x < 40 && z > 4 && z < 40 && !speck(x, z), () => 1, (x, z) => (speck(x, z) ? -2 : -1));
        const edges = refineWaterEdges(info, { baked: true, ground: (x, z) => (speck(x, z) ? -2 : -1) });
        expect(edges.draw[20 * n + 20]).toBeGreaterThan(0);
        expect(edges.surface[20 * n + 20]).toBe(1);
    });

    it('meets the other water at a seam both sides draw to, overlapping a little, never apart', () => {
        // Two crops of one bake: the river owns x < 20.5, the lake beyond. Each grid is the same lattice.
        const ground = () => -2;
        const river = grid(n, cell, x => x < 20.5, () => 1, ground, x => x >= 20.5);
        const lake = grid(n, cell, x => x >= 20.5, () => 1, ground, x => x < 20.5);
        const a = refineWaterEdges(river, { baked: true, ground });
        const b = refineWaterEdges(lake, { baked: true, ground });
        const ra = zeroBetween(a.draw, n, cell, [15, 24], [26, 24])[0];
        const lb = zeroBetween(b.draw, n, cell, [26, 24], [15, 24])[0];
        expect(ra).toBeGreaterThan(lb);
        expect(ra - lb).toBeLessThan(2 * seamOverlap(cell) + 1e-3);
        // A mouth is no shore: the shore distance runs on through it.
        expect(sample(a.shore, n, cell, 20.5, 24)).toBeGreaterThan(2);
    });

    it('never stands a sheet out over the ground beside a cascade', () => {
        // A river falling 0.8 m a cell along x, between banks half a metre over it out to four cells from its
        // middle, past which the ground falls away three metres (a gorge's rim, then a cliff).
        const S = (x: number) => 30 - 0.8 * x;
        const profile = (d: number) => (d <= 4 ? 0.5 : 0.5 - 3.5 * Math.min(1, (d - 4) / 1.5));
        const ground = (x: number, z: number) => {
            const d = Math.abs(z - 24);
            return d <= 2 ? S(x) - 0.6 : S(x) + profile(d);
        };
        const info = grid(n, cell, (x, z) => Math.abs(z - 24) <= 2, x => S(x), ground);
        const edges = refineWaterEdges(info, { baked: true, ground });
        let worst = -Infinity;
        for (let x = 2; x < n - 2; x += 0.1) for (let z = 14; z <= 34; z += 0.1) {
            if (Math.abs(z - 24) < 2.6) continue;   // the water itself and its edge
            if (sample(edges.draw, n, cell, x, z) <= 0) continue;
            worst = Math.max(worst, sample(edges.surface, n, cell, x, z) - ground(x, z));
        }
        // Wherever it is drawn away from its own cells it is under the ground (a film's depth at most over it).
        expect(worst).toBeLessThan(0.07);
        // And it still runs on under the banks.
        expect(edges.draw[24 * n + 20 + 3 * n]).toBeGreaterThan(0);
    });

    it('does not run on over the drop behind a crest', () => {
        // Level water against a crest (the ground rises through it at x = 20.43, tops out at 21) and a drop behind.
        const level = 2;
        const ground = (x: number) => (x <= 19 ? 1 : x <= 21 ? 1 + 0.7 * (x - 19) : 2.4 - 3.6 * (x - 21));
        const info = grid(n, cell, x => x <= 20, () => level, x => ground(x));
        const edges = refineWaterEdges(info, { baked: true, ground: x => ground(x) });
        for (let x = 21.05; x < 24; x += 0.05) expect(sample(edges.draw, n, cell, x, 24)).toBeLessThan(0);
        // It reaches the waterline (hidden under the crest past it), and the water is level.
        const line = zeroBetween(edges.draw, n, cell, [17, 24], [21, 24])[0];
        expect(line).toBeGreaterThan(20.43);
        for (let x = 10; x <= 20; x++) expect(edges.surface[24 * n + x]).toBeCloseTo(level, 6);
    });

    it('draws over a pocket only where something hides it', () => {
        const pocket = (x: number, z: number) => x >= 19 && x <= 21 && z >= 19 && z <= 21;
        const wet = (x: number, z: number) => x > 4 && x < 40 && z > 4 && z < 40 && !pocket(x, z);
        const make = (g: number) => grid(n, cell, wet, () => 1, (x, z) => (pocket(x, z) ? g : -1));
        // A hollow the bake left dry (ground under the water): not drawn over.
        const hollow = refineWaterEdges(make(-0.5), { baked: true, ground: (x, z) => (pocket(x, z) ? -0.5 : -1) });
        expect(hollow.draw[20 * n + 20]).toBeLessThan(0);
        // The same round a post standing through the water: drawn over at the water's level.
        const post = refineWaterEdges(make(-0.5), { baked: true, ground: (x, z) => (pocket(x, z) ? -0.5 : -1), walls: (x, z) => pocket(x, z) });
        expect(post.draw[20 * n + 20]).toBeGreaterThan(0);
        expect(post.surface[20 * n + 20]).toBe(1);
        // An outcrop standing out of it: drawn over, under the rock.
        const rock = refineWaterEdges(make(1.6), { baked: true, ground: (x, z) => (pocket(x, z) ? 1.6 : -1) });
        expect(rock.draw[20 * n + 20]).toBeGreaterThan(0);
    });

    it('clips a bake to its shape and a margin, and ends the water on that line', () => {
        // The bake left water on past the shape (x < 20): overflow out to x = 30.
        const shapeEdge = (x: number) => 20 - x;
        const info = grid(n, cell, x => x <= 30, () => 1, () => -2);
        const margin = clipMargin(cell);
        const clip = clipWaterToShape(info, (x) => shapeEdge(x), margin, true);
        for (let x = 0; x < n; x++) expect(info.info1[(24 * n + x) * 4 + 3] > 0.5).toBe(x <= 20 + margin);
        const edges = refineWaterEdges(info, { baked: true, ground: () => -2, clipEdge: clip });
        const at = zeroBetween(edges.draw, n, cell, [15, 24], [28, 24])[0];
        expect(Math.abs(at - (20 + margin))).toBeLessThan(0.1 * cell);
        // Nothing to clip: nothing changes.
        const whole = grid(n, cell, x => x <= 18, () => 1, () => -2);
        const before = whole.info1.slice();
        clipWaterToShape(whole, (x) => shapeEdge(x), margin, true);
        expect(whole.info1).toEqual(before);
    });

    it('keeps a mouth when both waters are clipped to the shapes they join', () => {
        const ground = () => -2;
        const lakeEdge = (x: number, z: number) => 10 - Math.hypot(x - 34, z - 24);
        const ribbon = (x: number, z: number) => Math.min(4 - Math.abs(z - 24), 22 - x);
        // Crops of one field: the river owns x < 20.5 inside its ribbon, the lake beyond; a spill all round.
        const spill = (x: number, z: number) => Math.abs(z - 24) < 12;
        const river = grid(n, cell, (x, z) => x < 20.5 && spill(x, z), () => 1, ground, (x, z) => x >= 20.5 && spill(x, z));
        const lake = grid(n, cell, (x, z) => x >= 20.5 && spill(x, z), () => 1, ground, (x, z) => x < 20.5 && spill(x, z));
        const keep = (x: number, z: number) => Math.max(ribbon(x, z), lakeEdge(x, z));
        const m = clipMargin(cell);
        const a = refineWaterEdges(river, { baked: true, ground, clipEdge: clipWaterToShape(river, keep, m, true) });
        const b = refineWaterEdges(lake, { baked: true, ground, clipEdge: clipWaterToShape(lake, keep, m, true) });
        const ra = zeroBetween(a.draw, n, cell, [15, 24], [26, 24])[0];
        const lb = zeroBetween(b.draw, n, cell, [26, 24], [15, 24])[0];
        expect(ra).toBeGreaterThan(lb);
        expect(ra - lb).toBeLessThan(2 * seamOverlap(cell) + 1e-3);
        // The spill outside both is gone from both.
        expect(sample(a.draw, n, cell, 10, 33)).toBeLessThan(0);
        expect(sample(b.draw, n, cell, 26, 35)).toBeLessThan(0);
    });

    it('marks the tiles of a cascade steep, and level ones not', () => {
        const fall = grid(64, cell, () => true, x => 40 - 0.9 * x, x => 39 - 0.9 * x);
        const flat = grid(64, cell, () => true, () => 1, () => 0);
        expect([...refineWaterEdges(fall, { baked: true }).tileSteep].every(v => v === 1)).toBe(true);
        expect([...refineWaterEdges(flat, { baked: true }).tileSteep].every(v => v === 0)).toBe(true);
    });

    it('meets a joined water on that water’s own outline when it is drawn from shapes', () => {
        // An unbaked river running into a lake whose outline is the circle round (34, 24) of radius 10: the
        // river hands its cells inside it over, and both cut on the lake's own edge.
        const lakeEdge = (x: number, z: number) => 10 - Math.hypot(x - 34, z - 24);
        const ribbon = (x: number, z: number) => 4 - Math.abs(z - 24);
        const ground = () => -3;
        const river = grid(n, cell, (x, z) => ribbon(x, z) > 0 && lakeEdge(x, z) <= 0, () => 1, ground, (x, z) => lakeEdge(x, z) > 0);
        const lake = grid(n, cell, (x, z) => lakeEdge(x, z) > 0, () => 1, ground, (x, z) => ribbon(x, z) > 0 && lakeEdge(x, z) <= 0);
        const r = refineWaterEdges(river, { shapeEdge: ribbon, otherEdge: lakeEdge, ground });
        const l = refineWaterEdges(lake, { shapeEdge: lakeEdge, otherEdge: ribbon, ground });
        for (const z of [21.3, 24, 26.6]) {
            const x0 = 34 - Math.sqrt(100 - (z - 24) ** 2);
            const ra = zeroBetween(r.draw, n, cell, [x0 - 3, z], [x0 + 3, z])[0];
            const lb = zeroBetween(l.draw, n, cell, [x0 + 3, z], [x0 - 3, z])[0];
            expect(Math.abs(ra - x0)).toBeLessThan(0.08 * cell);
            expect(Math.abs(lb - x0)).toBeLessThan(0.08 * cell);
            expect(ra).toBeGreaterThan(lb);
            expect(ra - lb).toBeLessThan(2 * seamOverlap(cell) + 0.03);
        }
    });
});
