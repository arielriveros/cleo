// Auto-tiling: a terrain set maps a neighbour bitmask to the tiles that fit it. The masks are the
// standard Wang families — `edge` (4 orthogonal bits), `corner` (4 diagonals), `blob` (all 8, with
// 47-blob normalization). Hexagonal grids always use all six bits whatever the declared kind.

import type { TerrainSet, VariantSet, WangKind } from "./tileset";

/**
 * Fold a neighbour-sameness ring into the bitmask a terrain set is keyed by. `same` must be in
 * {@link neighbours} order. The blob case drops any diagonal whose two adjacent edges are not both set,
 * which is what collapses 256 combinations into the 47 that are visually distinct.
 */
export function autoTileMask(kind: WangKind, same: boolean[]): number {
    if (same.length === 6) {
        let m = 0;
        for (let i = 0; i < 6; i++) if (same[i]) m |= 1 << i;
        return m;
    }
    if (kind === 'edge') {
        let m = 0;
        for (let i = 0; i < 4; i++) if (same[i * 2]) m |= 1 << i;      // N, E, S, W
        return m;
    }
    if (kind === 'corner') {
        let m = 0;
        for (let i = 0; i < 4; i++) if (same[i * 2 + 1]) m |= 1 << i;  // NE, SE, SW, NW
        return m;
    }
    let m = 0;
    for (let i = 0; i < 8; i++) {
        if (!same[i]) continue;
        if (i % 2 === 1) {
            // A diagonal only reads as "filled" when the two edges flanking it are filled too.
            const prev = same[(i + 7) % 8];
            const next = same[(i + 1) % 8];
            if (!prev || !next) continue;
        }
        m |= 1 << i;
    }
    return m;
}

/**
 * Tile to draw for `mask`, or -1 when the set has nothing for it. Falls back to the edge-only mask
 * first, so an edge-authored set still answers a blob mask rather than punching a hole in the map.
 */
export function resolveAutoTile(set: TerrainSet, mask: number, rng: () => number = Math.random): number {
    const pick = (candidates: number[] | undefined): number => {
        if (!candidates || candidates.length === 0) return -1;
        if (candidates.length === 1) return candidates[0];
        return candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
    };
    const exact = pick(set.tiles[mask]);
    if (exact >= 0) return exact;
    const edgesOnly = mask & 0b01010101;
    if (edgesOnly !== mask) {
        const relaxed = pick(set.tiles[edgesOnly]);
        if (relaxed >= 0) return relaxed;
    }
    return pick(set.tiles[0]);
}

/**
 * Draw one tile from a variant set by weight, or -1 when it is empty. A non-positive weight parks a
 * variant without deleting it.
 */
export function pickWeightedVariant(set: VariantSet, rng: () => number = Math.random): number {
    let total = 0;
    for (const t of set.tiles) total += Math.max(0, t.weight);
    if (total <= 0) return set.tiles.length > 0 ? set.tiles[0].index : -1;
    let roll = rng() * total;
    for (const t of set.tiles) {
        roll -= Math.max(0, t.weight);
        if (roll <= 0) return t.index;
    }
    return set.tiles[set.tiles.length - 1].index;
}

/**
 * Deterministic per-cell hash in [0, 1). Used instead of `Math.random` when scattering variants, so
 * repainting the same cells — or reloading the map — produces the same result.
 */
export function cellNoise(col: number, row: number, seed: number = 0): number {
    let h = (col * 374761393 + row * 668265263 + seed * 1274126177) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
}
