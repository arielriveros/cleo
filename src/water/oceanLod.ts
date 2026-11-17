// The tiles an endless ocean is drawn with: a CDLOD quadtree (Strugar, "Continuous Distance-Dependent Level
// of Detail for Rendering Heightmaps", 2009) centred on the camera. Pure: no GPU, so it is tested on its own
// and the shader's morph (shaders/wgsl/water.wgsl `vs_main`) mirrors `oceanMorph` here operation for
// operation.
//
// A tile at level L is OCEAN_TILE_0 · 2^L metres across and is drawn with OCEAN_QUADS quads; level L covers
// the camera's distances up to `oceanRange(L)`. Inside that range a node splits into its four children;
// past it the parent draws. Across the outer stretch of each range a tile's odd vertices slide onto the
// even ones (the next level's grid), so where two levels meet their edges are the same line of vertices:
// no cracks, no skirts. Distances are 3D, to the water's level, so looking down from high up the detail
// spreads out evenly.
//
// The ranges grow by 2 per level and are at least 1.41 tile sizes past the previous one (OCEAN_RANGE_K =
// 2.5 tile sizes), which guarantees a tile only ever borders tiles one level away.

/** Metres across a level-0 tile. */
export const OCEAN_TILE_0 = 16;
/** Quads across a whole tile (a quarter of a node drawn at its parent's density has half). */
export const OCEAN_QUADS = 32;
/** Levels 0..OCEAN_LEVELS-1: the last reaches hundreds of kilometres, the horizon from any height. */
export const OCEAN_LEVELS = 15;
/** A level's range, in its own tile sizes. */
export const OCEAN_RANGE_K = 2.5;
/** Where across a level's own stretch (from the previous range to its own) its morph starts. */
export const OCEAN_MORPH_START = 0.7;

export interface OceanTile {
    /** World x, z of the tile's corner, and its size, metres. */
    x0: number; z0: number; size: number;
    /** The level whose density it is drawn at. */
    level: number;
    /** Quads across the tile: OCEAN_QUADS, or half for a quarter of a node drawn at its parent's level. */
    quads: number;
    /** Distances over which its vertices morph onto the next level's grid. */
    morphStart: number; morphEnd: number;
}

/** How far from the camera level `level` is drawn. */
export function oceanRange(level: number): number {
    return OCEAN_RANGE_K * OCEAN_TILE_0 * Math.pow(2, level);
}

/** The morph distances of level `level`. */
export function oceanMorphRange(level: number): [number, number] {
    const end = oceanRange(level), start = level > 0 ? oceanRange(level - 1) : 0;
    return [start + (end - start) * OCEAN_MORPH_START, end];
}

/** Distance from `cam` to the box [x0, x0+s] x [y0, y1] x [z0, z0+s]. */
function boxDistance(cam: ArrayLike<number>, x0: number, z0: number, s: number, y0: number, y1: number): number {
    const dx = Math.max(x0 - cam[0], 0, cam[0] - (x0 + s));
    const dy = Math.max(y0 - cam[1], 0, cam[1] - y1);
    const dz = Math.max(z0 - cam[2], 0, cam[2] - (z0 + s));
    return Math.hypot(dx, dy, dz);
}

/**
 * The tiles to draw an endless ocean at `level` (its resting height) round the camera `cam`. `reach` is how
 * far the waves move the surface up and down (the culling box's half height); `visible` culls a box (the
 * frustum's side planes), and gets [x0, y0, z0], [x1, y1, z1].
 */
export function selectOceanTiles(cam: ArrayLike<number>, level: number, reach: number,
                                 visible: (min: number[], max: number[]) => boolean = () => true,
                                 out: OceanTile[] = []): OceanTile[] {
    out.length = 0;
    const top = OCEAN_LEVELS - 1;
    const rootSize = OCEAN_TILE_0 * Math.pow(2, top);
    const y0 = level - reach, y1 = level + reach;
    const min = [0, 0, 0], max = [0, 0, 0];
    const seen = (x0: number, z0: number, s: number) => {
        min[0] = x0; min[1] = y0; min[2] = z0;
        max[0] = x0 + s; max[1] = y1; max[2] = z0 + s;
        return visible(min, max);
    };
    const add = (x0: number, z0: number, size: number, lod: number, quads: number) => {
        const [morphStart, morphEnd] = oceanMorphRange(lod);
        out.push({ x0, z0, size, level: lod, quads, morphStart, morphEnd });
    };
    // Returns whether the node is accounted for (drawn, or out of view); false: too far for its level,
    // and its parent draws its area.
    const select = (x0: number, z0: number, lod: number): boolean => {
        const size = OCEAN_TILE_0 * Math.pow(2, lod);
        if (boxDistance(cam, x0, z0, size, y0, y1) > oceanRange(lod)) return false;
        if (!seen(x0, z0, size)) return true;
        if (lod === 0 || boxDistance(cam, x0, z0, size, y0, y1) > oceanRange(lod - 1)) {
            add(x0, z0, size, lod, OCEAN_QUADS);
            return true;
        }
        const half = size / 2;
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
            const cx = x0 + i * half, cz = z0 + j * half;
            // A child too far for its own level is drawn as this node's quarter, at this node's density.
            if (!select(cx, cz, lod - 1) && seen(cx, cz, half)) add(cx, cz, half, lod, OCEAN_QUADS / 2);
        }
        return true;
    };
    const r = oceanRange(top);
    const i0 = Math.floor((cam[0] - r) / rootSize), i1 = Math.floor((cam[0] + r) / rootSize);
    const j0 = Math.floor((cam[2] - r) / rootSize), j1 = Math.floor((cam[2] + r) / rootSize);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) select(i * rootSize, j * rootSize, top);
    return out;
}

/**
 * Where vertex (gx, gz) of `tile` (grid coordinates 0..1) lands after the morph, as world x, z: odd vertices
 * slide onto the even ones as the camera distance (to the vertex, at the water's `level`) crosses the
 * tile's morph range. The shader does exactly this.
 */
export function oceanMorph(tile: OceanTile, gx: number, gz: number, cam: ArrayLike<number>, level: number,
                           out: number[] = [0, 0]): number[] {
    const x = tile.x0 + gx * tile.size, z = tile.z0 + gz * tile.size;
    const d = Math.hypot(cam[0] - x, cam[1] - level, cam[2] - z);
    const k = Math.min(1, Math.max(0, (d - tile.morphStart) / Math.max(tile.morphEnd - tile.morphStart, 1e-3)));
    const n = tile.quads;
    const fx = (gx * n * 0.5 - Math.floor(gx * n * 0.5)) * 2 / n;
    const fz = (gz * n * 0.5 - Math.floor(gz * n * 0.5)) * 2 / n;
    out[0] = tile.x0 + (gx - fx * k) * tile.size;
    out[1] = tile.z0 + (gz - fz * k) * tile.size;
    return out;
}
