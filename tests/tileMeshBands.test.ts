import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Tilemap } from '../src/graphics/tilemap/tilemap';
import { Tileset } from '../src/graphics/tilemap/tileset';
import { TileMesh } from '../src/graphics/tilemap/tileMesh';
import { packCell } from '../src/graphics/tilemap/chunk';

// The depth bands a Y-sorted chunk is cut into carry the map-local rectangle their tiles cover, which is
// what lets the batched 2D pass draw a sprite on the far side of a band it cannot touch.

const proto = TileMesh.prototype as unknown as { _upload: (...args: unknown[]) => void };
let upload: typeof proto._upload;
beforeAll(() => { upload = proto._upload; proto._upload = () => {}; });
afterAll(() => { proto._upload = upload; });

describe('TileMesh depth bands', () => {
    it('bound each band by its tiles, a multi-cell tile\'s whole span included', () => {
        const tm = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
        const ts = new Tileset({ id: 'ts', textureId: 'atlas.png', imageWidth: 64, imageHeight: 64,
                                 tileWidth: 16, tileHeight: 16, columns: 4, rows: 4 });
        ts.setMeta(1, { spanX: 2, spanY: 3 });
        tm.registerTileset(ts);
        const layer = tm.addLayer({ name: 'Props', tilesetId: 'ts', ySorted: true });
        layer.set(0, 0, packCell(0));
        layer.set(3, 0, packCell(0));
        layer.set(1, 5, packCell(1));

        const chunk = [...layer.chunks.values()][0];
        const mesh = new TileMesh();
        mesh.build(chunk, layer, ts, tm.grid, 0);
        const bands = mesh.bands;
        expect(bands.length).toBe(2);
        let indices = 0;
        for (const b of bands) {
            indices += b.indexCount;
            expect(b.minX).toBeLessThan(b.maxX);
            expect(b.minY).toBeLessThan(b.maxY);
        }
        expect(indices).toBe(3 * 6);
        // The row-0 band holds both single tiles; the tall tile's band spans two columns and three rows.
        const row0 = bands.find(b => b.indexCount === 12)!;
        const tall = bands.find(b => b.indexCount === 6)!;
        expect(row0.maxX - row0.minX).toBeCloseTo(4, 6);
        expect(row0.maxY - row0.minY).toBeCloseTo(1, 6);
        expect(tall.maxX - tall.minX).toBeCloseTo(2, 6);
        expect(tall.maxY - tall.minY).toBeCloseTo(3, 6);
    });
});
