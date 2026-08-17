import { describe, it, expect } from 'vitest';
import {
    GridSpec, cellCorners, cellSortY, cellToWorld, neighbours, normalizeGrid, worldToCell,
} from '../src/tilemap/cellMath';

const ORTHO: GridSpec = { kind: 'orthogonal', cellWidth: 1, cellHeight: 1 };
const ORTHO_WIDE: GridSpec = { kind: 'orthogonal', cellWidth: 2.5, cellHeight: 1.25 };
const ISO: GridSpec = { kind: 'isometric', cellWidth: 2, cellHeight: 1 };
const HEX_POINTY: GridSpec = { kind: 'hexagonal', cellWidth: 1, cellHeight: 1.1547, hexOrientation: 'pointy' };
const HEX_FLAT: GridSpec = { kind: 'hexagonal', cellWidth: 1.1547, cellHeight: 1, hexOrientation: 'flat' };
const HEX_EVEN: GridSpec = { ...HEX_POINTY, hexOffset: 'even-r' };
const HEX_FLAT_EVEN: GridSpec = { ...HEX_FLAT, hexOffset: 'even-q' };

// Deliberately spans negatives: the map is unbounded in every direction, and floor-vs-truncate bugs
// only ever show up left of and above the origin.
const CELLS: [number, number][] = [];
for (let c = -5; c <= 5; c++) for (let r = -5; r <= 5; r++) CELLS.push([c, r]);

describe('cellMath round-trip', () => {
    for (const [name, grid] of Object.entries({ ORTHO, ORTHO_WIDE, ISO, HEX_POINTY, HEX_FLAT, HEX_EVEN, HEX_FLAT_EVEN })) {
        it(`${name}: worldToCell(cellToWorld(c,r)) === [c,r]`, () => {
            for (const [c, r] of CELLS) {
                const p = cellToWorld(grid, c, r);
                expect(worldToCell(grid, p[0], p[1]), `cell ${c},${r}`).toEqual([c, r]);
            }
        });
    }

    it('rows grow downward: row 1 sits below row 0', () => {
        expect(cellToWorld(ORTHO, 0, 1)[1]).toBeLessThan(cellToWorld(ORTHO, 0, 0)[1]);
        expect(cellToWorld(ISO, 0, 1)[1]).toBeLessThan(cellToWorld(ISO, 0, 0)[1]);
        expect(cellToWorld(HEX_POINTY, 0, 1)[1]).toBeLessThan(cellToWorld(HEX_POINTY, 0, 0)[1]);
    });

    it('orthogonal: a point anywhere inside a cell resolves to that cell', () => {
        for (const [c, r] of CELLS) {
            for (const [fx, fy] of [[0.01, 0.01], [0.99, 0.99], [0.5, 0.5], [0.01, 0.99]]) {
                const x = (c + fx) * ORTHO_WIDE.cellWidth;
                const y = -(r + fy) * ORTHO_WIDE.cellHeight;
                expect(worldToCell(ORTHO_WIDE, x, y)).toEqual([c, r]);
            }
        }
    });

    it('hex: points near a shared edge fall on one of the two hexes sharing it, never a third', () => {
        // The seam is exactly where naive bounding-box division goes wrong, so sample across it.
        for (const grid of [HEX_POINTY, HEX_FLAT, HEX_EVEN, HEX_FLAT_EVEN]) {
            for (const [c, r] of CELLS) {
                const centre = cellToWorld(grid, c, r);
                const ring = neighbours(grid, c, r);
                for (const [nc, nr] of ring) {
                    const n = cellToWorld(grid, nc, nr);
                    const midX = (centre[0] + n[0]) / 2, midY = (centre[1] + n[1]) / 2;
                    // Nudge 1% off the seam toward this cell; it must land here.
                    const x = midX + (centre[0] - midX) * 0.02;
                    const y = midY + (centre[1] - midY) * 0.02;
                    expect(worldToCell(grid, x, y), `seam ${c},${r} -> ${nc},${nr}`).toEqual([c, r]);
                }
            }
        }
    });

    it('hex neighbours are reciprocal', () => {
        for (const grid of [HEX_POINTY, HEX_FLAT, HEX_EVEN, HEX_FLAT_EVEN]) {
            for (const [c, r] of CELLS) {
                for (const [nc, nr] of neighbours(grid, c, r)) {
                    const back = neighbours(grid, nc, nr);
                    expect(back.some(([bc, br]) => bc === c && br === r), `${c},${r} <-> ${nc},${nr}`).toBe(true);
                }
            }
        }
    });

    it('neighbour counts: 8 on square/isometric grids, 6 on hexagonal', () => {
        expect(neighbours(ORTHO, 0, 0)).toHaveLength(8);
        expect(neighbours(ISO, 0, 0)).toHaveLength(8);
        expect(neighbours(HEX_POINTY, 0, 0)).toHaveLength(6);
    });
});

describe('cellCorners', () => {
    it('emits 4 points for square/isometric and 6 for hexagonal', () => {
        expect(cellCorners(ORTHO, 0, 0)).toHaveLength(8);
        expect(cellCorners(ISO, 0, 0)).toHaveLength(8);
        expect(cellCorners(HEX_POINTY, 0, 0)).toHaveLength(12);
    });

    it('the outline is centred on the cell centre', () => {
        for (const grid of [ORTHO_WIDE, ISO, HEX_POINTY, HEX_FLAT]) {
            const corners = cellCorners(grid, 3, -2);
            const centre = cellToWorld(grid, 3, -2);
            let sx = 0, sy = 0;
            for (let i = 0; i < corners.length; i += 2) { sx += corners[i]; sy += corners[i + 1]; }
            const n = corners.length / 2;
            expect(sx / n).toBeCloseTo(centre[0], 5);
            expect(sy / n).toBeCloseTo(centre[1], 5);
        }
    });

    it('winds counter-clockwise (positive shoelace area), which the collider prisms rely on', () => {
        for (const grid of [ORTHO_WIDE, ISO, HEX_POINTY, HEX_FLAT]) {
            const c = cellCorners(grid, 0, 0);
            let area = 0;
            for (let i = 0; i < c.length; i += 2) {
                const j = (i + 2) % c.length;
                area += c[i] * c[j + 1] - c[j] * c[i + 1];
            }
            expect(area).toBeGreaterThan(0);
        }
    });
});

describe('cellSortY', () => {
    it('an anchored tile sorts at its anchor row, not the row it was placed on', () => {
        // A two-cell-tall tree placed at row 4 with anchorRow 1 sorts where row 5 does — its trunk.
        expect(cellSortY(ORTHO, 0, 4, 1)).toBeCloseTo(cellToWorld(ORTHO, 0, 5)[1], 6);
        expect(cellSortY(ORTHO, 0, 4, 0)).toBeCloseTo(cellToWorld(ORTHO, 0, 4)[1], 6);
    });
});

describe('normalizeGrid', () => {
    it('snaps a mismatched hex offset to its orientation family instead of shearing the map', () => {
        expect(normalizeGrid({ ...HEX_POINTY, hexOffset: 'odd-q' }).hexOffset).toBe('odd-r');
        expect(normalizeGrid({ ...HEX_FLAT, hexOffset: 'even-r' }).hexOffset).toBe('odd-q');
    });

    it('defaults the side length to half the stacking extent', () => {
        expect(normalizeGrid(HEX_POINTY).hexSideLength).toBeCloseTo(HEX_POINTY.cellHeight / 2, 6);
        expect(normalizeGrid(HEX_FLAT).hexSideLength).toBeCloseTo(HEX_FLAT.cellWidth / 2, 6);
    });
});
