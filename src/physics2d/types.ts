// The 2D physics vocabulary: what a tile is to a body, the shapes the world is made of, and the layers
// areas filter by. A leaf module: no engine imports, so the scene graph, the tilemap and the tests can all
// reach it without a cycle.

/** A cell nothing collides with. */
export const TILE_NONE = 0;
/** A cell that is solid all the way through. */
export const TILE_SOLID = 1;
/** A cell stood on from above and passed through from below and the sides (TileMeta.oneWay). */
export const TILE_ONE_WAY = 2;
/** A cell solid below a line from its left edge's height to its right edge's (TileMeta.slope). */
export const TILE_SLOPE = 3;

/** What a cell is to a body: one of the TILE_ kinds. */
export type TileKind = typeof TILE_NONE | typeof TILE_SOLID | typeof TILE_ONE_WAY | typeof TILE_SLOPE;

/**
 * An orthogonal tile grid as the 2D physics reads it. Cell (col, row) spans x in
 * [originX + col * cellWidth, originX + (col + 1) * cellWidth] and y in
 * [originY - (row + 1) * cellHeight, originY - row * cellHeight]: rows grow DOWNWARD, as a tilemap's do.
 */
export interface Grid2D {
    readonly originX: number;
    readonly originY: number;
    readonly cellWidth: number;
    readonly cellHeight: number;
    /**
     * What cell (col, row) is (a TILE_ kind). For a slope, its floor heights at the left and right edges,
     * fractions of the cell, are written into `slope`.
     */
    sample(col: number, row: number, slope: [number, number]): number;
}

/**
 * A box collider of the 2D world (Body2DNode): solid, or a one-way platform. `dx`/`dy` are how far it moved
 * this step, which a body standing on it is carried by.
 */
export interface Box2D {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    oneWay: boolean;
    dx: number;
    dy: number;
    /** The node it belongs to, for whoever asks what a body stands on. */
    owner: unknown;
}

/** Everything a body collides with in one step. */
export interface CollisionWorld2D {
    grids: Grid2D[];
    boxes: Box2D[];
}

/** An axis-aligned rectangle: [minX, minY, maxX, maxY]. */
export type Rect2D = [number, number, number, number];
