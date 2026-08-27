// Grid geometry for the three tilemap layouts. Pure math — no GL, no scene graph.
//
// CONVENTIONS, fixed here and relied on everywhere else: the tile plane is XY (+Y up, +X right);
// ROW INDICES GROW DOWNWARD, so row 1 sits below row 0 in world space; and `cellToWorld` returns a
// cell's CENTRE. Isometric means a screen-space diamond on the XY plane, not a 3D projection.

import { vec2 } from "gl-matrix";

export type GridKind = 'orthogonal' | 'isometric' | 'hexagonal';
/** Pointy-top hexes stack in offset ROWS; flat-top hexes stack in offset COLUMNS. */
export type HexOrientation = 'pointy' | 'flat';
/**
 * Which line gets the half-cell shove. `odd-r`/`even-r` pair with pointy-top (offset rows),
 * `odd-q`/`even-q` with flat-top (offset columns).
 */
export type HexOffset = 'odd-r' | 'even-r' | 'odd-q' | 'even-q';

export interface GridSpec {
    kind: GridKind;
    /** World width of one cell's bounding box. For isometric this is the full diamond width. */
    cellWidth: number;
    /** World height of one cell's bounding box. */
    cellHeight: number;
    hexOrientation?: HexOrientation;
    hexOffset?: HexOffset;
    /**
     * Length of the hexagon's two axis-aligned sides. Defaults to half the cell extent along the
     * stacking axis, giving a regular hexagon at a sqrt(3):2 bounding box.
     */
    hexSideLength?: number;
}

const SQRT3 = Math.sqrt(3);

/** Fill in the optional hex fields so the rest of this module can read them unconditionally. */
export function normalizeGrid(g: GridSpec): Required<GridSpec> {
    const orientation: HexOrientation = g.hexOrientation ?? 'pointy';
    // A mismatched offset (say 'odd-r' on a flat-top grid) would silently shear the map, so snap it to
    // the orientation's family rather than trusting the caller.
    const rowFamily = g.hexOffset === 'even-r' ? 'even-r' : 'odd-r';
    const colFamily = g.hexOffset === 'even-q' ? 'even-q' : 'odd-q';
    const offset: HexOffset = orientation === 'pointy'
        ? (g.hexOffset === 'odd-r' || g.hexOffset === 'even-r' ? g.hexOffset : rowFamily)
        : (g.hexOffset === 'odd-q' || g.hexOffset === 'even-q' ? g.hexOffset : colFamily);
    const along = orientation === 'pointy' ? g.cellHeight : g.cellWidth;
    return {
        kind: g.kind,
        cellWidth: g.cellWidth,
        cellHeight: g.cellHeight,
        hexOrientation: orientation,
        hexOffset: offset,
        hexSideLength: g.hexSideLength ?? along / 2,
    };
}

/** Distance between adjacent hex rows (pointy) or columns (flat). */
function hexStackSpacing(g: Required<GridSpec>): number {
    const along = g.hexOrientation === 'pointy' ? g.cellHeight : g.cellWidth;
    return (along + g.hexSideLength) / 2;
}

// --- cell -> world ----------------------------------------------------------------------------

/** World-space CENTRE of cell (col, row). */
export function cellToWorld(grid: GridSpec, col: number, row: number, out?: vec2): vec2 {
    const g = normalizeGrid(grid);
    const o = out ?? vec2.create();
    switch (g.kind) {
        case 'orthogonal':
            o[0] = (col + 0.5) * g.cellWidth;
            o[1] = -(row + 0.5) * g.cellHeight;
            return o;
        case 'isometric':
            // The diamond for (col,row) has its top vertex at ((col-row)*w/2, -(col+row)*h/2).
            o[0] = (col - row) * g.cellWidth * 0.5;
            o[1] = -(col + row + 1) * g.cellHeight * 0.5;
            return o;
        case 'hexagonal': {
            const spacing = hexStackSpacing(g);
            if (g.hexOrientation === 'pointy') {
                const shifted = g.hexOffset === 'odd-r' ? (row & 1) !== 0 : (row & 1) === 0;
                o[0] = (col + 0.5 + (shifted ? 0.5 : 0)) * g.cellWidth;
                o[1] = -(row * spacing + g.cellHeight * 0.5);
            } else {
                const shifted = g.hexOffset === 'odd-q' ? (col & 1) !== 0 : (col & 1) === 0;
                o[0] = col * spacing + g.cellWidth * 0.5;
                o[1] = -((row + 0.5 + (shifted ? 0.5 : 0)) * g.cellHeight);
            }
            return o;
        }
    }
}

// --- world -> cell ----------------------------------------------------------------------------

/** Round a fractional cube coordinate to the nearest hex, fixing up the axis with the largest error. */
function cubeRound(qf: number, rf: number): [number, number] {
    const xf = qf, zf = rf, yf = -qf - rf;
    let rx = Math.round(xf), ry = Math.round(yf), rz = Math.round(zf);
    const dx = Math.abs(rx - xf), dy = Math.abs(ry - yf), dz = Math.abs(rz - zf);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    return [rx, rz];
}

/**
 * Cell containing the world-space point (x, y); never null, since the grid is infinite. The hex branch
 * rounds in cube coordinates — dividing by the spacing treats each hex as its bounding box.
 */
export function worldToCell(grid: GridSpec, x: number, y: number): [col: number, row: number] {
    const g = normalizeGrid(grid);
    // `| 0` throughout: floor/round return -0 near the origin, which compares unequal under Object.is
    // while indexing the same cell.
    switch (g.kind) {
        case 'orthogonal':
            return [Math.floor(x / g.cellWidth) | 0, Math.floor(-y / g.cellHeight) | 0];
        case 'isometric': {
            // In (p,q) space a cell's diamond is a rotated unit square, so the half-sum and
            // half-difference below land on integers at cell centres.
            const p = (2 * x) / g.cellWidth;
            const q = (-2 * y) / g.cellHeight - 1;
            return [Math.round((p + q) * 0.5) | 0, Math.round((q - p) * 0.5) | 0];
        }
        case 'hexagonal': {
            const spacing = hexStackSpacing(g);
            // Normalized so the axial layout is the plain shear x = q + r/2, y = r. The `even-*`
            // variants shift the whole grid half a cell, which is the extra half taken off below.
            const half = (g.hexOffset === 'even-r' || g.hexOffset === 'even-q') ? 1 : 0.5;
            if (g.hexOrientation === 'pointy') {
                const xn = x / g.cellWidth - half;
                const yn = (-y - g.cellHeight * 0.5) / spacing;
                const [q, r] = cubeRound(xn - yn * 0.5, yn);
                const col = g.hexOffset === 'odd-r'
                    ? q + ((r - (r & 1)) >> 1)
                    : q + ((r + (r & 1)) >> 1);
                return [col | 0, r | 0];
            } else {
                const xn = (x - g.cellWidth * 0.5) / spacing;
                const yn = -y / g.cellHeight - half;
                const [q, r] = cubeRound(xn, yn - xn * 0.5);
                const row = g.hexOffset === 'odd-q'
                    ? r + ((q - (q & 1)) >> 1)
                    : r + ((q + (q & 1)) >> 1);
                return [q | 0, row | 0];
            }
        }
    }
}

// --- footprint --------------------------------------------------------------------------------

/**
 * Outline of cell (col, row) as flat world-space xy pairs, counter-clockwise: 4 points for orthogonal
 * and isometric, 6 for hexagonal.
 */
export function cellCorners(grid: GridSpec, col: number, row: number, out?: Float32Array): Float32Array {
    const g = normalizeGrid(grid);
    const n = g.kind === 'hexagonal' ? 6 : 4;
    const o = out && out.length >= n * 2 ? out : new Float32Array(n * 2);
    const c = cellToWorld(g, col, row);
    const cx = c[0], cy = c[1];
    const hw = g.cellWidth * 0.5, hh = g.cellHeight * 0.5;

    if (g.kind === 'orthogonal') {
        o[0] = cx - hw; o[1] = cy - hh;
        o[2] = cx + hw; o[3] = cy - hh;
        o[4] = cx + hw; o[5] = cy + hh;
        o[6] = cx - hw; o[7] = cy + hh;
    } else if (g.kind === 'isometric') {
        o[0] = cx;      o[1] = cy - hh; // bottom
        o[2] = cx + hw; o[3] = cy;      // right
        o[4] = cx;      o[5] = cy + hh; // top
        o[6] = cx - hw; o[7] = cy;      // left
    } else if (g.hexOrientation === 'pointy') {
        const hs = g.hexSideLength * 0.5;
        o[0] = cx;      o[1] = cy - hh;
        o[2] = cx + hw; o[3] = cy - hs;
        o[4] = cx + hw; o[5] = cy + hs;
        o[6] = cx;      o[7] = cy + hh;
        o[8] = cx - hw; o[9] = cy + hs;
        o[10] = cx - hw; o[11] = cy - hs;
    } else {
        const hs = g.hexSideLength * 0.5;
        o[0] = cx + hs; o[1] = cy - hh;
        o[2] = cx + hw; o[3] = cy;
        o[4] = cx + hs; o[5] = cy + hh;
        o[6] = cx - hs; o[7] = cy + hh;
        o[8] = cx - hw; o[9] = cy;
        o[10] = cx - hs; o[11] = cy - hh;
    }
    return o;
}

/**
 * World Y a cell sorts at. `anchorRow` is an offset INTO the tile's own footprint, so a two-cell-tall
 * tree anchored at 1 sorts by its trunk and the whole object moves as one.
 */
export function cellSortY(grid: GridSpec, col: number, row: number, anchorRow: number = 0): number {
    return cellToWorld(grid, col, row + anchorRow)[1];
}

// --- adjacency --------------------------------------------------------------------------------

// Orthogonal/isometric ring order, starting north and turning clockwise. Auto-tiling reads the first
// four for edge (4-bit) rules and all eight for blob (8-bit) rules, so the order is load-bearing.
const RING_8: readonly [number, number][] = [
    [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

/**
 * The cells touching (col, row), clockwise: 8 for orthogonal and isometric grids, 6 for hexagonal.
 * Hex neighbours depend on row/column PARITY, which is why this is not open-coded per call site.
 */
export function neighbours(grid: GridSpec, col: number, row: number): [number, number][] {
    const g = normalizeGrid(grid);
    if (g.kind !== 'hexagonal') return RING_8.map(([dc, dr]) => [col + dc, row + dr] as [number, number]);

    if (g.hexOrientation === 'pointy') {
        const shifted = g.hexOffset === 'odd-r' ? (row & 1) !== 0 : (row & 1) === 0;
        const near = shifted ? 0 : -1;   // the diagonal that stays in the same column
        const far = shifted ? 1 : 0;
        return [
            [col + near, row - 1], [col + far, row - 1],
            [col + 1, row], [col + far, row + 1],
            [col + near, row + 1], [col - 1, row],
        ];
    }
    const shifted = g.hexOffset === 'odd-q' ? (col & 1) !== 0 : (col & 1) === 0;
    const near = shifted ? 0 : -1;
    const far = shifted ? 1 : 0;
    return [
        [col, row - 1], [col + 1, row + near], [col + 1, row + far],
        [col, row + 1], [col - 1, row + far], [col - 1, row + near],
    ];
}

/** How many neighbours a cell has on this grid (8 orthogonal/isometric, 6 hexagonal). */
export function neighbourCount(grid: GridSpec): number {
    return grid.kind === 'hexagonal' ? 6 : 8;
}
