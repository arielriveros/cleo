import { describe, it, expect } from 'vitest';
import { Tilemap } from '../src/graphics/tilemap/tilemap';
import { Tileset } from '../src/graphics/tilemap/tileset';
import { TilemapLayer } from '../src/graphics/tilemap/tilemapLayer';
import {
    CELL_EMPTY, CHUNK_SIZE, cellFlipX, cellRot90, cellTile, chunkCoord, chunkKey, packCell,
} from '../src/graphics/tilemap/chunk';
import { greedyMerge } from '../src/graphics/tilemap/tilemapCollision';
import { autoTileMask, cellNoise, pickWeightedVariant } from '../src/graphics/tilemap/autotile';
import { bytesToBase64 } from '../src/core/base64';

function tileset(id = 'ts'): Tileset {
    return new Tileset({
        id, textureId: 'atlas.png',
        imageWidth: 64, imageHeight: 64, tileWidth: 16, tileHeight: 16,
        columns: 4, rows: 4,
    });
}

function map(): Tilemap {
    const tm = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
    const ts = tileset();
    tm.registerTileset(ts);
    tm.addLayer({ name: 'Ground', tilesetId: 'ts' });
    return tm;
}

describe('cell packing', () => {
    it('round-trips the tile index and the three orientation bits', () => {
        for (const idx of [0, 1, 7, 1000, 0xfffff]) {
            for (const [fx, fy, rot] of [[false, false, false], [true, false, false], [false, true, true], [true, true, true]] as const) {
                const packed = packCell(idx, fx, fy, rot);
                expect(cellTile(packed)).toBe(idx);
                expect(cellFlipX(packed)).toBe(fx);
                expect(cellRot90(packed)).toBe(rot);
            }
        }
    });

    it('tile 0 is a real tile, and only an empty cell reads as -1', () => {
        expect(packCell(0)).not.toBe(CELL_EMPTY);
        expect(cellTile(packCell(0))).toBe(0);
        expect(cellTile(CELL_EMPTY)).toBe(-1);
    });

    it('chunk keys are collision-free across the addressable range', () => {
        const seen = new Set<number>();
        for (let cx = -100; cx <= 100; cx++)
            for (let cy = -100; cy <= 100; cy++) {
                const key = chunkKey(cx, cy);
                expect(seen.has(key), `${cx},${cy}`).toBe(false);
                seen.add(key);
            }
    });

    it('chunkCoord floors, so negative cells land in the chunk left of / above the origin', () => {
        expect(chunkCoord(0)).toBe(0);
        expect(chunkCoord(CHUNK_SIZE - 1)).toBe(0);
        expect(chunkCoord(CHUNK_SIZE)).toBe(1);
        expect(chunkCoord(-1)).toBe(-1);
        expect(chunkCoord(-CHUNK_SIZE)).toBe(-1);
        expect(chunkCoord(-CHUNK_SIZE - 1)).toBe(-2);
    });
});

describe('layer storage', () => {
    it('allocates a chunk on write and frees it when its last tile is erased', () => {
        const layer = new TilemapLayer();
        expect(layer.chunks.size).toBe(0);
        layer.set(3, 4, packCell(1));
        layer.set(40, 4, packCell(1));
        expect(layer.chunks.size).toBe(2);
        layer.set(3, 4, CELL_EMPTY);
        expect(layer.chunks.size).toBe(1);
        layer.set(40, 4, CELL_EMPTY);
        expect(layer.chunks.size).toBe(0);
    });

    it('erasing an unpainted cell never allocates', () => {
        const layer = new TilemapLayer();
        layer.set(-500, 900, CELL_EMPTY);
        expect(layer.chunks.size).toBe(0);
    });

    it('set returns the previous packed value — the undo diff depends on it', () => {
        const layer = new TilemapLayer();
        expect(layer.set(1, 1, packCell(5))).toBe(CELL_EMPTY);
        expect(layer.set(1, 1, packCell(6))).toBe(packCell(5));
    });

    it('bounds spans negative coordinates', () => {
        const layer = new TilemapLayer();
        layer.set(-7, -3, packCell(0));
        layer.set(2, 9, packCell(0));
        expect(layer.bounds()).toEqual({ minCol: -7, minRow: -3, maxCol: 2, maxRow: 9 });
        expect(new TilemapLayer().bounds()).toBeNull();
    });
});

describe('serialization', () => {
    it('round-trips cells, layer config and embedded tilesets', () => {
        const tm = map();
        tm.setTile(0, 5, 6, 3, { flipX: true, rot90: true });
        tm.setTile(0, -40, 12, 1);
        tm.layers[0].cfg.parallax = [0.5, 0.25];
        tm.layers[0].cfg.ySorted = true;
        tm.entityLayer = 0;
        tm.collisionDepth = 1.25;

        const back = Tilemap.deserialize(JSON.parse(JSON.stringify(tm.serialize())));
        expect(back.getTile(0, 5, 6)).toEqual({ tileIndex: 3, flipX: true, flipY: false, rot90: true });
        expect(back.getTile(0, -40, 12)?.tileIndex).toBe(1);
        expect(back.layers[0].cfg.parallax).toEqual([0.5, 0.25]);
        expect(back.layers[0].cfg.ySorted).toBe(true);
        expect(back.collisionDepth).toBe(1.25);
        expect(back.tilesetById('ts')?.textureId).toBe('atlas.png');
    });

    it('embeds only the tilesets its layers actually reference', () => {
        const tm = map();
        tm.registerTileset(tileset('unused'));
        expect(tm.serialize().tilesets.map((t: any) => t.id)).toEqual(['ts']);
    });

    it('accepts a pre-decoded Uint32Array, the form the published player hands over', () => {
        const tm = map();
        tm.setTile(0, 1, 2, 7);
        const json = tm.serialize();
        const chunk = json.layers[0].chunks[0];

        // Swap the editor's base64 for the typed array the blob inflater produces.
        const cells = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE);
        cells[2 * CHUNK_SIZE + 1] = packCell(7);
        delete chunk.data;
        chunk.cellsU32 = cells;

        expect(Tilemap.deserialize(json).getTile(0, 1, 2)?.tileIndex).toBe(7);
    });

    it('accepts a plain number array for hand-authored content', () => {
        const cells = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
        cells[0] = packCell(2);
        const back = Tilemap.deserialize({
            grid: { kind: 'orthogonal', cellWidth: 1, cellHeight: 1 },
            layers: [{ name: 'L', visible: true, opacity: 1, chunks: [{ cx: 0, cy: 0, cells }] }],
        });
        expect(back.getTile(0, 0, 0)?.tileIndex).toBe(2);
    });

    it('survives a chunk with no cell payload at all', () => {
        const back = Tilemap.deserialize({
            grid: { kind: 'orthogonal', cellWidth: 1, cellHeight: 1 },
            layers: [{ name: 'L', chunks: [{ cx: 0, cy: 0 }] }],
        });
        expect(back.layers[0].chunks.size).toBe(0);
    });

    it('tolerates a truncated base64 payload rather than throwing', () => {
        const short = bytesToBase64(new Uint8Array(10)); // not a whole number of Uint32s
        const back = Tilemap.deserialize({
            grid: { kind: 'orthogonal', cellWidth: 1, cellHeight: 1 },
            layers: [{ name: 'L', chunks: [{ cx: 0, cy: 0, data: short }] }],
        });
        expect(back.layers).toHaveLength(1);
    });

    it('a map with no layers deserializes with one, so painting always has a target', () => {
        expect(Tilemap.deserialize({}).layers).toHaveLength(1);
    });
});

describe('editing', () => {
    it('fillRect covers the inclusive rectangle regardless of corner order', () => {
        const tm = map();
        tm.fillRect(0, 4, 4, 2, 1, 9);
        for (let c = 2; c <= 4; c++)
            for (let r = 1; r <= 4; r++) expect(tm.getTile(0, c, r)?.tileIndex, `${c},${r}`).toBe(9);
        expect(tm.getTile(0, 5, 4)).toBeNull();
        expect(tm.getTile(0, 2, 0)).toBeNull();
    });

    it('bucketFill replaces the connected region only', () => {
        const tm = map();
        tm.fillRect(0, 0, 0, 4, 4, 1);
        tm.fillRect(0, 2, 0, 2, 4, 2);   // a wall down the middle
        tm.bucketFill(0, 0, 0, 5);
        expect(tm.getTile(0, 0, 0)?.tileIndex).toBe(5);
        expect(tm.getTile(0, 1, 3)?.tileIndex).toBe(5);
        expect(tm.getTile(0, 2, 2)?.tileIndex).toBe(2);   // the wall
        expect(tm.getTile(0, 3, 3)?.tileIndex).toBe(1);   // the far side
    });

    it('bucketFill honours its cell limit — the map is infinite, a misclick must not be', () => {
        const tm = map();
        tm.bucketFill(0, 0, 0, 1, undefined, 50);
        let painted = 0;
        for (const layer of tm.layers) painted += layer.tileCount;
        expect(painted).toBeLessThanOrEqual(50);
        expect(painted).toBeGreaterThan(0);
    });

    it('bucketFill is a no-op when the target tile is already there', () => {
        const tm = map();
        tm.setTile(0, 0, 0, 3);
        const before = tm.version;
        tm.bucketFill(0, 0, 0, 3);
        expect(tm.version).toBe(before);
    });

    it('recordEdits collects a replayable diff, and applyEdits reverses it exactly', () => {
        const tm = map();
        tm.fillRect(0, 0, 0, 2, 2, 1);
        const snapshot = tm.serialize();

        const { edits } = tm.recordEdits(() => {
            tm.fillRect(0, 0, 0, 3, 3, 4);
            tm.eraseTile(0, 1, 1);
        });
        expect(edits.length).toBeGreaterThan(0);
        expect(tm.getTile(0, 3, 3)?.tileIndex).toBe(4);

        tm.applyEdits(edits, true);
        expect(JSON.stringify(tm.serialize())).toBe(JSON.stringify(snapshot));

        tm.applyEdits(edits, false);
        expect(tm.getTile(0, 3, 3)?.tileIndex).toBe(4);
        expect(tm.getTile(0, 1, 1)).toBeNull();
    });

    it('applyEdits does not record itself', () => {
        const tm = map();
        const { edits } = tm.recordEdits(() => tm.setTile(0, 0, 0, 1));
        const { edits: nested } = tm.recordEdits(() => tm.applyEdits(edits, true));
        expect(nested).toHaveLength(0);
    });

    it('beginEdit/endEdit is a re-entrant depth counter, not a boolean', () => {
        const tm = map();
        tm.beginEdit();
        tm.beginEdit();
        tm.endEdit();
        expect(tm.editing).toBe(true);
        tm.endEdit();
        expect(tm.editing).toBe(false);
        tm.endEdit();                 // unbalanced extra must not go negative
        expect(tm.editing).toBe(false);
    });

    it('a per-cell tint override round-trips and restores on undo', () => {
        const tm = map();
        tm.setTile(0, 1, 1, 0);
        const { edits } = tm.recordEdits(() => tm.setTint(0, 1, 1, 0xff8800ff));
        expect(tm.layers[0].getTint(1, 1)).toBe(0xff8800ff);
        tm.applyEdits(edits, true);
        expect(tm.layers[0].getTint(1, 1)).toBe(0);
    });
});

describe('solidity', () => {
    it('reads per-tile solid flags from the layer tileset', () => {
        const tm = map();
        tm.tilesetById('ts')!.setMeta(1, { solid: true });
        tm.setTile(0, 0, 0, 1);
        tm.setTile(0, 1, 0, 2);
        expect(tm.isSolid(0, 0)).toBe(true);
        expect(tm.isSolid(1, 0)).toBe(false);
    });

    it('a dedicated collision layer makes any tile solid', () => {
        const tm = map();
        tm.addLayer({ name: 'Collision', collision: true });
        tm.setTile(1, 5, 5, 0);
        expect(tm.isSolid(5, 5)).toBe(true);
    });

    it('a parallaxed layer never contributes collision — its art is drawn somewhere else', () => {
        const tm = map();
        tm.tilesetById('ts')!.setMeta(1, { solid: true });
        tm.setTile(0, 0, 0, 1);
        expect(tm.isSolid(0, 0)).toBe(true);
        tm.layers[0].cfg.parallax = [0.5, 0.5];
        expect(tm.isSolid(0, 0)).toBe(false);
    });

    it('solidAtWorld follows the map origin', () => {
        const tm = map();
        tm.tilesetById('ts')!.setMeta(1, { solid: true });
        tm.setTile(0, 0, 0, 1);
        expect(tm.solidAtWorld(0.5, -0.5)).toBe(true);
        tm.setOrigin(new Float32Array([10, 0, 0]) as unknown as any);
        expect(tm.solidAtWorld(0.5, -0.5)).toBe(false);
        expect(tm.solidAtWorld(10.5, -0.5)).toBe(true);
    });
});

describe('greedyMerge', () => {
    const bitmap = (rows: string[]): { solid: Uint8Array; w: number; h: number } => {
        const h = rows.length, w = rows[0].length;
        const solid = new Uint8Array(w * h);
        rows.forEach((line, r) => [...line].forEach((ch, c) => { solid[r * w + c] = ch === '#' ? 1 : 0; }));
        return { solid, w, h };
    };
    const coverage = (rows: string[]) => {
        const { solid, w, h } = bitmap(rows);
        const boxes = greedyMerge(solid, w, h);
        const covered = new Uint8Array(w * h);
        for (const b of boxes)
            for (let r = b.r0; r <= b.r1; r++)
                for (let c = b.c0; c <= b.c1; c++) {
                    expect(covered[r * w + c], 'boxes must not overlap').toBe(0);
                    covered[r * w + c] = 1;
                }
        for (let i = 0; i < solid.length; i++) expect(covered[i], `cell ${i}`).toBe(solid[i]);
        return boxes;
    };

    it('empty', () => expect(coverage(['....', '....'])).toHaveLength(0));
    it('single cell', () => expect(coverage(['....', '.#..'])).toHaveLength(1));
    it('a full rectangle collapses to one box', () => expect(coverage(['####', '####', '####'])).toHaveLength(1));
    it('an L-shape covers exactly, without spilling into the notch', () => coverage(['##..', '##..', '####']));
    it('a hole in the middle is never covered over', () => coverage(['####', '#..#', '####']));
    it('a checkerboard is the worst case: one box per cell', () => {
        const boxes = coverage(['#.#.', '.#.#', '#.#.', '.#.#']);
        expect(boxes).toHaveLength(8);
    });
    it('degenerate dimensions return nothing', () => {
        expect(greedyMerge(new Uint8Array(0), 0, 0)).toHaveLength(0);
    });
});

describe('autotile', () => {
    it('blob masks drop a diagonal whose flanking edges are not both filled', () => {
        // N, NE, E, SE, S, SW, W, NW — NE set but N and E clear.
        const same = [false, true, false, false, false, false, false, false];
        expect(autoTileMask('blob', same)).toBe(0);
        same[0] = true; same[2] = true;
        expect(autoTileMask('blob', same)).toBe(0b111);
    });

    it('edge and corner masks read their own four neighbours', () => {
        const same = [true, false, false, false, false, false, false, false];
        expect(autoTileMask('edge', same)).toBe(0b0001);
        expect(autoTileMask('corner', same)).toBe(0);
        expect(autoTileMask('corner', [false, true, false, false, false, false, false, false])).toBe(0b0001);
    });

    it('a six-neighbour ring uses all six bits whatever the declared kind', () => {
        expect(autoTileMask('edge', [true, false, true, false, false, true])).toBe(0b100101);
    });

    it('cellNoise is deterministic per cell and spread across [0,1)', () => {
        expect(cellNoise(3, -7, 2)).toBe(cellNoise(3, -7, 2));
        expect(cellNoise(3, -7, 2)).not.toBe(cellNoise(3, -7, 3));
        const values = [];
        for (let c = 0; c < 40; c++) for (let r = 0; r < 40; r++) values.push(cellNoise(c, r));
        expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...values)).toBeLessThan(1);
        expect(new Set(values).size).toBeGreaterThan(1000);
    });

    it('weighted variants respect their weights and ignore non-positive ones', () => {
        const set = { id: 0, name: 'v', tiles: [{ index: 1, weight: 0 }, { index: 2, weight: 1 }] };
        expect(pickWeightedVariant(set, () => 0.5)).toBe(2);
        expect(pickWeightedVariant({ id: 0, name: 'v', tiles: [] })).toBe(-1);
    });
});

describe('Tileset', () => {
    it('uvOf accounts for margin and spacing, and flips V for the upload orientation', () => {
        const ts = new Tileset({
            id: 't', textureId: 'a', imageWidth: 100, imageHeight: 100,
            tileWidth: 10, tileHeight: 10, margin: 5, spacing: 2, columns: 3, rows: 3,
        });
        const uv = ts.uvOf(0);
        expect(uv[0]).toBeCloseTo(0.05, 6);
        expect(uv[2]).toBeCloseTo(0.15, 6);
        // Tile 0 is the atlas's TOP row, so it occupies the HIGH end of texture v.
        expect(uv[3]).toBeCloseTo(0.95, 6);
        expect(uv[1]).toBeCloseTo(0.85, 6);
        // Tile 1 is one column right; tile 3 is one row down.
        expect(ts.uvOf(1)[0]).toBeCloseTo(0.17, 6);
        expect(ts.uvOf(3)[3]).toBeCloseTo(0.83, 6);
    });

    it('frameOf cycles animated tiles and returns others unchanged, including at negative time', () => {
        const ts = tileset();
        ts.setMeta(0, { animation: { frames: [0, 1, 2], fps: 10 } });
        expect(ts.frameOf(0, 0)).toBe(0);
        expect(ts.frameOf(0, 0.15)).toBe(1);
        expect(ts.frameOf(0, 0.25)).toBe(2);
        expect(ts.frameOf(0, 0.35)).toBe(0);
        expect(ts.frameOf(0, -0.05)).toBe(2);
        expect(ts.frameOf(5, 99)).toBe(5);
    });

    it('serialize round-trips metadata, terrains and variant sets', () => {
        const ts = tileset();
        ts.setMeta(2, { solid: true, anchorRow: 1, spanY: 2, zBias: 0.25, tint: [1, 0.5, 0] });
        ts.terrains.push({ id: 1, name: 'grass', kind: 'blob', tiles: { 0: [4], 255: [5, 6] } });
        ts.variantSets.push({ id: 1, name: 'rocks', tiles: [{ index: 7, weight: 2 }] });

        const back = Tileset.parse(JSON.parse(JSON.stringify(ts.serialize())));
        expect(back.metaOf(2)).toEqual({ solid: true, anchorRow: 1, spanY: 2, zBias: 0.25, tint: [1, 0.5, 0] });
        expect(back.terrainSet(1)?.tiles[255]).toEqual([5, 6]);
        expect(back.variantSet(1)?.tiles[0].weight).toBe(2);
    });

    it('setMeta with an empty object clears the entry rather than storing a husk', () => {
        const ts = tileset();
        ts.setMeta(1, { solid: true });
        ts.setMeta(1, {});
        expect(ts.metaOf(1)).toBeUndefined();
    });
});
