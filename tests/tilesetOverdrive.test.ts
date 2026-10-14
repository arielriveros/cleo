import { describe, it, expect } from 'vitest';
import { Tileset, MAX_TILESET_OVERDRIVE } from '../src/graphics/tilemap/tileset';
import { Sprite } from '../src/graphics/sprite';
import { SpriteNode } from '../src/core/scene/nodes/spriteNode';
import { AnimatedSpriteNode } from '../src/core/scene/nodes/animatedSpriteNode';
import { TilemapLayer } from '../src/graphics/tilemap/tilemapLayer';
import { TileMesh } from '../src/graphics/tilemap/tileMesh';
import { packCell } from '../src/graphics/tilemap/chunk';
import { Material } from '../src/graphics/material';

// Overdrive is a tileset's linear brightness past white, which is what lets a fire sprite or a lava tile
// cross the bloom threshold. Pinned here: the data round-trips without churning old files, a tile's own
// value wins, the sprite reads the tile actually on screen, the tilemap tint carries it in the space its
// shader expects, and every other Basic-material surface still draws at ×1.

const tileset = (overdrive?: number) => new Tileset({
    id: 'fire', textureId: 'fire.png',
    imageWidth: 64, imageHeight: 16, tileWidth: 16, tileHeight: 16,
    columns: 4, rows: 1, overdrive,
});

describe('Tileset overdrive', () => {
    it('defaults to 1 and leaves the serialized form untouched', () => {
        const ts = tileset();
        expect(ts.overdrive).toBe(1);
        expect(ts.overdriveOf(2)).toBe(1);
        expect('overdrive' in ts.serialize()).toBe(false);
    });

    it('round-trips through serialize/parse', () => {
        const ts = tileset(3.5);
        ts.setMeta(1, { overdrive: 8 });
        const back = Tileset.parse(JSON.parse(JSON.stringify(ts.serialize())));
        expect(back.overdrive).toBe(3.5);
        expect(back.overdriveOf(0)).toBe(3.5);
        expect(back.overdriveOf(1)).toBe(8);
    });

    it('a tile override wins, including one that dims below the tileset', () => {
        const ts = tileset(4);
        ts.setMeta(2, { overdrive: 0.5 });
        expect(ts.overdriveOf(2)).toBe(0.5);
        expect(ts.overdriveOf(3)).toBe(4);
    });

    it('clamps nonsense to the authoring range', () => {
        expect(tileset(-2).overdrive).toBe(0);
        expect(tileset(1e6).overdrive).toBe(MAX_TILESET_OVERDRIVE);
        expect(tileset(NaN).overdrive).toBe(1);
    });
});

describe('sprite overdrive', () => {
    it('reads the tileset for a static sprite', () => {
        const node = new SpriteNode('s', new Sprite({ tileset: tileset(3), tileIndex: 1 }));
        expect(node.overdrive).toBe(3);
    });

    it('is 1 for a sprite without a tileset', () => {
        expect(new SpriteNode('s', new Sprite({})).overdrive).toBe(1);
    });

    it('follows the frame on screen for an animated sprite', () => {
        const ts = tileset(2);
        ts.setMeta(1, { overdrive: 6 }); // the flare frame
        const node = new AnimatedSpriteNode('a', new Sprite({ tileset: ts }), { frames: [0, 1], fps: 10, loop: true });
        expect(node.currentTile).toBe(0);
        expect(node.overdrive).toBe(2);
        node.update(0.1, 0.1);
        expect(node.currentTile).toBe(1);
        expect(node.overdrive).toBe(6);
    });
});

describe('Basic material intensity', () => {
    it('defaults to 1, so icons and basic models are unchanged, and is never serialized', () => {
        const m = Material.Basic({});
        expect(m.properties.get('intensity')).toBe(1);
        expect(JSON.stringify(m.serialize())).not.toContain('intensity');
        // Old JSON goes through Material.Basic as well, so it gets the default too.
        expect(Material.parse(m.serialize()).properties.get('intensity')).toBe(1);
    });
});

describe('tilemap overdrive', () => {
    // The tile shader does toLinear(tint) = tint^2.2, so the mesh bakes overdrive^(1/2.2) into the tint.
    const tintOf = (ts: Tileset, tile: number): number[] => {
        const layer = new TilemapLayer();
        layer.set(0, 0, packCell(tile));
        const chunk = layer.chunks.values().next().value!;
        const mesh = new TileMesh();
        let captured: Float32Array | null = null;
        (mesh as any)._upload = (verts: Float32Array) => { captured = verts.slice(); };
        mesh.build(chunk, layer, ts, { kind: 'orthogonal', cellWidth: 1, cellHeight: 1 } as any, 0);
        return Array.from(captured!.subarray(4, 7));
    };

    it('leaves the tint alone at overdrive 1', () => {
        expect(tintOf(tileset(), 0)).toEqual([1, 1, 1]);
    });

    it('scales the tint so the linear colour is exactly ×overdrive', () => {
        const ts = tileset(4);
        ts.setMeta(2, { tint: [1, 0.5, 0.25] });
        const [r, g, b] = tintOf(ts, 2);
        expect(Math.pow(r, 2.2)).toBeCloseTo(4, 4);
        expect(Math.pow(g, 2.2)).toBeCloseTo(4 * Math.pow(0.5, 2.2), 4);
        expect(Math.pow(b, 2.2)).toBeCloseTo(4 * Math.pow(0.25, 2.2), 4);
    });
});
