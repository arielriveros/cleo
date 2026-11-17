import { closestOnSegmentXZ, pointInPolygonXZ, polygonEdgeDistance2XZ, type ResolvedWaterShape } from '../physics/water/waterColumn';
import type { WaterBody } from './waterShapes';

// Carving: a river's or lake's bed dug into a height grid, so the water has a channel to sit in. Pure over
// a plain grid (row-major, `resolution`² samples over `size` metres centred on `origin`), so the Terrain
// edit and its undo stay the caller's (the editor saves the touched rectangle before writing it).
//
// Only ever LOWERS the ground: a bank that is already below the water's bed is left alone.

/** The grid a carve reads and writes: Terrain's height field in world terms. */
export interface CarveGrid {
    heights: Float32Array;
    resolution: number;
    /** Metres the grid spans, edge sample to edge sample. */
    size: number;
    /** World position of the grid's centre; heights are relative to `origin[1]`. */
    origin: ArrayLike<number>;
}

/** Inclusive rectangle of grid samples (Terrain's GridRegion). */
export interface CarveRegion { c0: number; r0: number; c1: number; r1: number; }

/**
 * Where the bed should be at (x, z) for one body: `bed` (world height) and `outside` (metres beyond the
 * water's edge, 0 or less inside). Null where the body has no bed (a pool, an ocean) or the point is far.
 */
function bedAt(r: ResolvedWaterShape, x: number, z: number, extraDepth: number, reach: number): { bed: number; outside: number } | null {
    if (x < r.min[0] - reach || x > r.max[0] + reach || z < r.min[2] - reach || z > r.max[2] + reach) return null;
    if (r.type === 'lake') {
        const d = Math.sqrt(polygonEdgeDistance2XZ(x, z, r.outline));
        const inside = pointInPolygonXZ(x, z, r.outline);
        // Bowl: full depth a few metres in from the shore, easing to the shore line.
        const depth = r.level - r.floor;
        const bowl = inside ? Math.min(1, d / Math.max(1, depth * 2)) : 0;
        return { bed: r.level - depth * (0.25 + 0.75 * bowl) - extraDepth * bowl, outside: inside ? -d : d };
    }
    if (r.type === 'river') {
        let best = Infinity, bi = -1, bt = 0;
        const tmp = [0, 0];
        for (let i = 0; i + 1 < r.samples.length; i++) {
            const a = r.samples[i], b = r.samples[i + 1];
            closestOnSegmentXZ(x, z, a.x, a.z, b.x, b.z, tmp);
            if (tmp[1] < best) { best = tmp[1]; bi = i; bt = tmp[0]; }
        }
        if (bi < 0) return null;
        const a = r.samples[bi], b = r.samples[bi + 1];
        const half = (a.width + (b.width - a.width) * bt) / 2;
        const depth = a.depth + (b.depth - a.depth) * bt;
        const surface = a.y + (b.y - a.y) * bt;
        const d = Math.sqrt(best);
        const u = Math.min(1, d / Math.max(1e-3, half));
        // The same parabolic channel the water queries assume, so the bed is where the water says it is.
        return { bed: surface - (depth + extraDepth) * Math.max(0.15, 1 - u * u), outside: d - half };
    }
    return null;
}

/**
 * Lowers `grid` under a river or lake whose body has `carve.enabled` (`r` its resolved form): the bed inside
 * the water, easing back up to the original ground over `carve.bankWidth` outside it. Returns the grid
 * rectangle it changed (null when nothing did), for an undo step and a refresh.
 */
export function carveWater(grid: CarveGrid, body: WaterBody, r: ResolvedWaterShape | null): CarveRegion | null {
    const R = grid.resolution, half = grid.size / 2, step = grid.size / (R - 1);
    const oy = grid.origin[1];
    let region: CarveRegion | null = null;
    const shape = body;
    if (r && shape.carve.enabled && (r.type === 'river' || r.type === 'lake')) {
        const bank = Math.max(0, shape.carve.bankWidth);
        const reach = bank + 1;
        const c0 = Math.max(0, Math.floor((r.min[0] - reach - grid.origin[0] + half) / step));
        const c1 = Math.min(R - 1, Math.ceil((r.max[0] + reach - grid.origin[0] + half) / step));
        const r0 = Math.max(0, Math.floor((r.min[2] - reach - grid.origin[2] + half) / step));
        const r1 = Math.min(R - 1, Math.ceil((r.max[2] + reach - grid.origin[2] + half) / step));
        for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) {
            const x = grid.origin[0] - half + col * step, z = grid.origin[2] - half + row * step;
            const at = bedAt(r, x, z, shape.carve.extraDepth, reach);
            if (!at || at.outside > bank) continue;
            const i = row * R + col;
            const ground = grid.heights[i] + oy;
            let target: number;
            if (at.outside <= 0) target = at.bed;
            else {
                // The bank: from the bed at the water's edge back up to the ground, smoothly.
                const t = bank > 0 ? at.outside / bank : 1;
                const s = t * t * (3 - 2 * t);
                target = at.bed + (ground - at.bed) * s;
            }
            if (target >= ground) continue;
            grid.heights[i] = target - oy;
            if (!region) region = { c0: col, r0: row, c1: col, r1: row };
            else {
                region.c0 = Math.min(region.c0, col); region.c1 = Math.max(region.c1, col);
                region.r0 = Math.min(region.r0, row); region.r1 = Math.max(region.r1, row);
            }
        }
    }
    return region;
}
