import { YIELD_BELOW, waterColumnAt, type ResolvedWaterShape, type WaterColumn } from '../physics/water/waterColumn';

// The WATER INFO grid of a Water node: what the surface renderer reads per point (Unreal's Water Zone "water
// info texture"). Built here analytically from the shapes and the landscape under them; a bake
// (water/bake/) replaces it with the shallow-water simulation's settled flow, height and foam.
//
// Two RGBA float layers over the same XZ grid:
//   info0: resting surface height (world), flow x, flow z (m/s), shore distance (m; < 0 = dry)
//   info1: wave share (0..1), foam (0..1), bed height (world), wet (1 / 0)
// Dry cells take the surface of the nearest wet one, so a surface vertex that lands just past the shore
// does not spike to some other height.

/** Grid sizing limits. */
export const WATER_INFO_MAX_RES = 512;
export const WATER_INFO_MIN_CELL = 0.25;
/** Grid cells per surface tile along each axis. */
export const WATER_TILE_CELLS = 32;

/** Ground height at a world (x, z), or null where there is no ground (no landscape there). */
export type GroundSampler = (x: number, z: number) => number | null;

export interface WaterInfo {
    /** World XZ of cell (0, 0)'s centre, the cell size and the cell counts. */
    originX: number; originZ: number; cell: number; nx: number; nz: number;
    info0: Float32Array;
    info1: Float32Array;
    /** Lowest and highest resting surface on the grid. */
    minY: number; maxY: number;
    /** Surface tiles: `tileCells` cells square, `tilesX` × `tilesZ`, each with water or not. */
    tileCells: number; tilesX: number; tilesZ: number;
    tileWet: Uint8Array;
    tileMinY: Float32Array; tileMaxY: Float32Array;
    /** An endless ocean's level, which also covers everything outside the grid; null without one. */
    oceanLevel: number | null;
    /** Where it came from: 'analytic' or a bake id. */
    source: string;
    /**
     * An unbaked grid handed over to the water it joins ({@link handOverWaterInfo}): per cell, which of the
     * hand-over list's waters took it (its index), or -1. Absent: nothing was handed over.
     */
    handedBy?: Int8Array;
}

const SQRT2 = Math.SQRT2;

/**
 * Chamfer distance (metres) from every cell to the nearest cell where `mask` differs from its own, plus,
 * for every cell, the index of the nearest cell whose mask is set (−1 if none). Two passes, 3x3 kernel.
 */
export function chamferDistance(mask: Uint8Array, nx: number, nz: number, cell: number): { dist: Float32Array; nearestSet: Int32Array } {
    const n = nx * nz;
    const toSet = new Float32Array(n), toClear = new Float32Array(n);
    const nearestSet = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        toSet[i] = mask[i] ? 0 : Infinity;
        toClear[i] = mask[i] ? Infinity : 0;
        nearestSet[i] = mask[i] ? i : -1;
    }
    const relax = (i: number, j: number, w: number) => {
        if (toSet[j] + w < toSet[i]) { toSet[i] = toSet[j] + w; nearestSet[i] = nearestSet[j]; }
        if (toClear[j] + w < toClear[i]) toClear[i] = toClear[j] + w;
    };
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const i = z * nx + x;
        if (x > 0) relax(i, i - 1, 1);
        if (z > 0) {
            relax(i, i - nx, 1);
            if (x > 0) relax(i, i - nx - 1, SQRT2);
            if (x + 1 < nx) relax(i, i - nx + 1, SQRT2);
        }
    }
    for (let z = nz - 1; z >= 0; z--) for (let x = nx - 1; x >= 0; x--) {
        const i = z * nx + x;
        if (x + 1 < nx) relax(i, i + 1, 1);
        if (z + 1 < nz) {
            relax(i, i + nx, 1);
            if (x + 1 < nx) relax(i, i + nx + 1, SQRT2);
            if (x > 0) relax(i, i + nx - 1, SQRT2);
        }
    }
    const dist = new Float32Array(n);
    // Inside the set: distance to the nearest clear cell (positive); outside: minus the distance to the set.
    for (let i = 0; i < n; i++) dist[i] = mask[i] ? toClear[i] * cell : -toSet[i] * cell;
    return { dist, nearestSet };
}

/**
 * The analytic water info of `shapes` (world space) over the ground `ground`. Null when there is nothing
 * finite to cover (no shapes, or only an endless ocean, which the renderer draws without a grid).
 * `handOver`: other water this water gives way to where they overlap (see {@link handOverWaterInfo}).
 * `beside`: other water that carries on from this one's edge (the rivers running into a lake or out of it):
 * where it stands, this water's edge is no shore.
 */
export function buildWaterInfo(shapes: readonly ResolvedWaterShape[], ground: GroundSampler | null,
                               options: { maxRes?: number; minCell?: number; handOver?: readonly ResolvedWaterShape[];
                                          beside?: readonly ResolvedWaterShape[] } = {}): WaterInfo | null {
    const endless = shapes.find(s => s.type === 'ocean' && s.endless) ?? null;
    const finite = shapes.filter(s => !(s.type === 'ocean' && s.endless));
    if (!finite.length) return null;
    const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
    for (const s of finite) {
        min[0] = Math.min(min[0], s.min[0]); min[1] = Math.min(min[1], s.min[2]);
        max[0] = Math.max(max[0], s.max[0]); max[1] = Math.max(max[1], s.max[2]);
    }
    const maxRes = Math.max(16, Math.min(2048, options.maxRes ?? WATER_INFO_MAX_RES));
    const extent = Math.max(max[0] - min[0], max[1] - min[1], 1);
    const cell = Math.max(options.minCell ?? WATER_INFO_MIN_CELL, extent / (maxRes - 4));
    // Two cells of margin round the shapes, so the shore distance and the dilation have room.
    const originX = min[0] - 2 * cell, originZ = min[1] - 2 * cell;
    const nx = Math.min(maxRes, Math.ceil((max[0] - min[0]) / cell) + 5);
    const nz = Math.min(maxRes, Math.ceil((max[1] - min[1]) / cell) + 5);
    const n = nx * nz;
    const info0 = new Float32Array(n * 4), info1 = new Float32Array(n * 4);
    const wet = new Uint8Array(n);
    const col: WaterColumn = { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: 0, waveFactor: 1 };
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const i = z * nx + x;
        const wx = originX + x * cell, wz = originZ + z * cell;
        const c = waterColumnAt(shapes, wx, wz, col);
        const g = ground ? ground(wx, wz) : null;
        if (!c || (g !== null && g >= c.surface - 0.02)) {
            // Dry: still record the ground for the bed.
            info1[i * 4 + 2] = g ?? (c ? c.floor : 0);
            continue;
        }
        wet[i] = 1;
        info0[i * 4] = c.surface; info0[i * 4 + 1] = c.flowX; info0[i * 4 + 2] = c.flowZ;
        info1[i * 4] = c.waveFactor;
        info1[i * 4 + 2] = g !== null ? Math.max(g, c.floor) : c.floor;
        info1[i * 4 + 3] = 1;
    }
    const { dist, nearestSet } = chamferDistance(wet, nx, nz, cell);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        if (wet[i]) {
            // The shore is where the water ends: the ground rising out of it, or no shape there at all. A
            // shape's own edge is no shore where another shape's water carries on (a river's mouth in its lake).
            info0[i * 4 + 3] = dist[i];
            minY = Math.min(minY, info0[i * 4]); maxY = Math.max(maxY, info0[i * 4]);
        } else {
            info0[i * 4 + 3] = dist[i];
            const k = nearestSet[i];
            if (k >= 0) {
                info0[i * 4] = info0[k * 4]; info0[i * 4 + 1] = 0; info0[i * 4 + 2] = 0;
                info1[i * 4] = info1[k * 4];
            }
        }
    }
    if (!Number.isFinite(minY)) { minY = 0; maxY = 0; }
    // Foam where the water runs fast, changes speed or drops (rapids, a weir): the flow's gradient and
    // the surface's slope, per metre.
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const i = z * nx + x;
        if (!wet[i]) continue;
        const xl = x > 0 && wet[i - 1] ? i - 1 : i, xr = x + 1 < nx && wet[i + 1] ? i + 1 : i;
        const zl = z > 0 && wet[i - nx] ? i - nx : i, zr = z + 1 < nz && wet[i + nx] ? i + nx : i;
        const dxs = Math.max(1, (xr - xl)) * cell, dzs = Math.max(1, (zr - zl) / nx) * cell;
        const du = Math.hypot(info0[xr * 4 + 1] - info0[xl * 4 + 1], info0[zr * 4 + 1] - info0[zl * 4 + 1]) / Math.min(dxs, dzs);
        const dv = Math.hypot(info0[xr * 4 + 2] - info0[xl * 4 + 2], info0[zr * 4 + 2] - info0[zl * 4 + 2]) / Math.min(dxs, dzs);
        const slope = Math.hypot((info0[xr * 4] - info0[xl * 4]) / dxs, (info0[zr * 4] - info0[zl * 4]) / dzs);
        const speed = Math.hypot(info0[i * 4 + 1], info0[i * 4 + 2]);
        // Shear across a channel is normal and stays smooth; foam comes from drops and from fast water.
        info1[i * 4 + 1] = Math.min(1, (du + dv) * 0.12 + Math.max(0, slope - 0.05) * 3 + Math.max(0, speed - 1.5) * 0.25);
    }
    const info: WaterInfo = {
        originX, originZ, cell, nx, nz, info0, info1, minY, maxY,
        tileCells: 0, tilesX: 0, tilesZ: 0, tileWet: new Uint8Array(0), tileMinY: new Float32Array(0), tileMaxY: new Float32Array(0),
        oceanLevel: endless ? endless.level : null, source: 'analytic',
    };
    if ((options.handOver && options.handOver.length) || (options.beside && options.beside.length))
        handOverWaterInfo(info, options.handOver ?? [], ground, options.beside ?? []);
    else tileWaterInfo(info);
    return info;
}

/**
 * Hands the cells of `info` that lie in other water over to it: a river's mouth inside the lake it flows
 * into, its source inside the lake it drains. There the other node's water is the water: the cells are not
 * drawn (wet 0), and they count as water for the shore distance, so the river's edge there is no shore and
 * grows no foam. Cells in the water `beside` it (a lake's rivers) count as water for the shore distance too,
 * but stay this water's where it has them: a river's mouth is no shore of the lake. In place; re-tiles.
 */
export function handOverWaterInfo(info: WaterInfo, handOver: readonly ResolvedWaterShape[], ground: GroundSampler | null,
                                  beside: readonly ResolvedWaterShape[] = []): void {
    const { nx, nz, cell, info0, info1 } = info;
    const n = nx * nz;
    const wet = new Uint8Array(n), handed = new Uint8Array(n), more = new Uint8Array(n);
    const handedBy = new Int8Array(n).fill(-1);
    const col: WaterColumn = { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: 0, waveFactor: 1 };
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const i = z * nx + x;
        wet[i] = info1[i * 4 + 3] > 0.5 ? 1 : 0;
        const wx = info.originX + x * cell, wz = info.originZ + z * cell;
        const g = ground ? ground(wx, wz) : null;
        const c = handOver.length ? waterColumnAt(handOver, wx, wz, col) : null;
        // The water joined takes over only where this water has come down to its level, as physics decides
        // (buoyancy.ts waterAt, YIELD_BELOW): an endless sea is under every point (and with no landscape over
        // every ground), and a river still running down toward its lake is the water there.
        if (c && (g === null || g < c.surface - 0.02) && (!wet[i] || info0[i * 4] <= c.surface + YIELD_BELOW)) {
            handed[i] = 1;
            handedBy[i] = c.shape;
        }
        const b = !wet[i] && beside.length ? waterColumnAt(beside, wx, wz, col) : null;
        if (b && (g === null || g < b.surface - 0.02)) more[i] = 1;
    }
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = wet[i] | handed[i] | more[i];
    const { dist } = chamferDistance(mask, nx, nz, cell);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        info0[i * 4 + 3] = dist[i];
        if (handed[i]) { info1[i * 4 + 3] = 0; continue; }
        if (wet[i]) { minY = Math.min(minY, info0[i * 4]); maxY = Math.max(maxY, info0[i * 4]); }
    }
    if (Number.isFinite(minY)) { info.minY = minY; info.maxY = maxY; }
    if (handOver.length) info.handedBy = handedBy;
    tileWaterInfo(info);
}

/**
 * The step the COARSE part of a surface height is rounded to when a grid spanning `range` metres of height
 * goes to the GPU as half floats (render/water.ts). A half float holds 11 significant bits: 3 cm steps 32 m
 * up, which terraces a gently falling river and bands its normal across the stream. So a height is sent as
 * two numbers that add up: a multiple of this step, which half floats hold exactly anywhere in the range,
 * and the small remainder, which they hold to a few hundredths of a millimetre. Filtering is linear, so
 * the two filtered parts still add up to the filtered height.
 */
export function heightQuantum(range: number): number {
    // Every multiple of 2^(e - 10) up to 2^e is a half float exactly.
    const e = Math.ceil(Math.log2(Math.max(range, 1e-3) * 1.0001));
    return Math.pow(2, e - 10);
}

/** `height` as its coarse and fine parts for `quantum` (see {@link heightQuantum}): `out` = [coarse, fine]. */
export function splitHeight(height: number, quantum: number, out: number[] = [0, 0]): number[] {
    const coarse = Math.round(height / quantum) * quantum;
    out[0] = coarse; out[1] = height - coarse;
    return out;
}

/** Fill `info`'s surface tiles from its grid: which hold water, and their lowest and highest surface. */
export function tileWaterInfo(info: WaterInfo): void {
    const { nx, nz, info0, info1 } = info;
    const tileCells = WATER_TILE_CELLS;
    const tilesX = Math.max(1, Math.ceil((nx - 1) / tileCells)), tilesZ = Math.max(1, Math.ceil((nz - 1) / tileCells));
    const tileWet = new Uint8Array(tilesX * tilesZ);
    const tileMinY = new Float32Array(tilesX * tilesZ).fill(Infinity), tileMaxY = new Float32Array(tilesX * tilesZ).fill(-Infinity);
    for (let tz = 0; tz < tilesZ; tz++) for (let tx = 0; tx < tilesX; tx++) {
        const t = tz * tilesX + tx;
        for (let z = tz * tileCells; z <= Math.min(nz - 1, (tz + 1) * tileCells); z++)
            for (let x = tx * tileCells; x <= Math.min(nx - 1, (tx + 1) * tileCells); x++) {
                const i = z * nx + x;
                if (info1[i * 4 + 3] < 0.5) continue;
                tileWet[t] = 1;
                tileMinY[t] = Math.min(tileMinY[t], info0[i * 4]);
                tileMaxY[t] = Math.max(tileMaxY[t], info0[i * 4]);
            }
    }
    info.tileCells = tileCells; info.tilesX = tilesX; info.tilesZ = tilesZ;
    info.tileWet = tileWet; info.tileMinY = tileMinY; info.tileMaxY = tileMaxY;
}

/**
 * An endless ocean's SHORE grid at `level`, over the landscapes' rectangle (and a margin): where the land
 * rises out of the sea, how far each point is from it, and how deep the sea is there. The ocean is drawn
 * everywhere regardless; this only tells its waves where to die down and break, and its foam where the
 * beach is. Null without ground. Its `oceanLevel` is the level, and it has no surface tiles of its own.
 */
export function buildOceanShoreInfo(level: number, ground: GroundSampler | null,
                                    bounds: { min: readonly number[]; max: readonly number[] } | null,
                                    options: { maxRes?: number } = {}): WaterInfo | null {
    if (!ground || !bounds) return null;
    const margin = 32;
    const x0 = bounds.min[0] - margin, z0 = bounds.min[1] - margin;
    const x1 = bounds.max[0] + margin, z1 = bounds.max[1] + margin;
    const maxRes = Math.max(16, Math.min(2048, options.maxRes ?? WATER_INFO_MAX_RES));
    const cell = Math.max(1, Math.max(x1 - x0, z1 - z0) / (maxRes - 1));
    const nx = Math.min(maxRes, Math.ceil((x1 - x0) / cell) + 1), nz = Math.min(maxRes, Math.ceil((z1 - z0) / cell) + 1);
    const n = nx * nz;
    const info0 = new Float32Array(n * 4), info1 = new Float32Array(n * 4);
    const wet = new Uint8Array(n);
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const i = z * nx + x;
        const g = ground(x0 + x * cell, z0 + z * cell);
        wet[i] = g === null || g < level - 0.02 ? 1 : 0;
        info0[i * 4] = level;
        info1[i * 4] = 1;
        // Off the landscape, the sea is as deep as anything a wave cares about.
        info1[i * 4 + 2] = g ?? level - 1000;
        info1[i * 4 + 3] = wet[i];
    }
    const { dist } = chamferDistance(wet, nx, nz, cell);
    for (let i = 0; i < n; i++) info0[i * 4 + 3] = dist[i];
    return {
        originX: x0, originZ: z0, cell, nx, nz, info0, info1, minY: level, maxY: level,
        tileCells: WATER_TILE_CELLS, tilesX: 0, tilesZ: 0, tileWet: new Uint8Array(0), tileMinY: new Float32Array(0), tileMaxY: new Float32Array(0),
        oceanLevel: level, source: 'shore',
    };
}
