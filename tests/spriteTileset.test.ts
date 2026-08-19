import { describe, it, expect } from 'vitest';
import { Sprite, legacySheetTileset, remapLegacyFrame } from '../src/graphics/sprite';
import { Node, SpriteNode, AnimatedSpriteNode, parseNodeJson } from '../src/core/scene/node';
import { Tileset } from '../src/tilemap/tileset';

// Sprites draw one TILE of a tileset. Two things are worth pinning down: that the UV rect a sprite hands
// the renderer is the tileset's own (so margin/spacing atlases work at all), and that pre-tileset scenes
// still parse — including the row-origin flip, which would silently reorder every existing animation.

const ATLAS = () => new Tileset({
  id: 'atlas', textureId: 'atlas.png',
  imageWidth: 100, imageHeight: 100,
  tileWidth: 10, tileHeight: 10,
  margin: 5, spacing: 2,
  columns: 7, rows: 7,
});

describe('Sprite uv rect', () => {
  it('is the tileset rect of the selected tile', () => {
    const tileset = ATLAS();
    const sprite = new Sprite({ tileset, tileIndex: 9 });
    expect(sprite.uvRect()).toEqual([...tileset.uvOf(9)]);
  });

  it('honours margin and spacing rather than a naive grid', () => {
    const sprite = new Sprite({ tileset: ATLAS(), tileIndex: 1 });
    const [u0, v0, u1, v1] = sprite.uvRect();
    // Tile 1 starts at margin + 1 * (tile + spacing) = 5 + 12 = 17px across a 100px atlas.
    expect(u0).toBeCloseTo(0.17);
    expect(u1).toBeCloseTo(0.27);
    // Top row, and V is flipped: the tile's top edge is 5px down from the image top.
    expect(v1).toBeCloseTo(0.95);
    expect(v0).toBeCloseTo(0.85);
    // A naive 1/columns grid would have said 1/7 wide; it is 0.10.
    expect(u1 - u0).toBeCloseTo(0.1);
  });

  it('falls back to the whole quad with no tileset', () => {
    expect(new Sprite().uvRect()).toEqual([0, 0, 1, 1]);
  });

  it('clamps a tile index past the end of the set', () => {
    const sprite = new Sprite({ tileset: ATLAS(), tileIndex: 999 });
    expect(sprite.tileIndex).toBe(48); // 7x7 - 1
  });

  it('fromTexture samples the whole image, with no decoded image needed', () => {
    const sprite = Sprite.fromTexture('icon.png');
    expect(sprite.uvRect()).toEqual([0, 0, 1, 1]);
    expect(sprite.tileset?.textureId).toBe('icon.png');
    expect(sprite.material.textures.get('texture')).toBe('icon.png');
  });

  it('assigning a tileset rebinds the atlas texture on the internal material', () => {
    const sprite = Sprite.fromTexture('old.png');
    sprite.tileset = ATLAS();
    expect(sprite.material.textures.get('texture')).toBe('atlas.png');
    expect(sprite.material.properties.get('hasTexture')).toBe(true);

    sprite.tileset = null;
    expect(sprite.material.textures.has('texture')).toBe(false);
    expect(sprite.material.properties.get('hasTexture')).toBe(false);
  });
});

describe('legacy migration', () => {
  it('remapLegacyFrame mirrors the row, keeping the column', () => {
    // A 4x2 sheet: legacy frame 0 was the BOTTOM-left cell, which is tile 4 counting from the top-left.
    expect(remapLegacyFrame(0, 4, 2)).toBe(4);
    expect(remapLegacyFrame(3, 4, 2)).toBe(7);
    expect(remapLegacyFrame(4, 4, 2)).toBe(0);
    expect(remapLegacyFrame(7, 4, 2)).toBe(3);
  });

  it('a legacy sheet tileset reproduces the old grid arithmetic, top-down', () => {
    const tileset = legacySheetTileset('fire.png', 8, 4);
    expect(tileset.columns).toBe(8);
    expect(tileset.rows).toBe(4);
    // Tile 0 is the top-left cell: 1/8 wide, and the topmost quarter of V.
    const [u0, v0, u1, v1] = tileset.uvOf(0);
    expect(u0).toBeCloseTo(0);
    expect(u1).toBeCloseTo(0.125);
    expect(v0).toBeCloseTo(0.75);
    expect(v1).toBeCloseTo(1);
  });

  it('a legacy static sprite becomes a 1x1 tileset over the same texture', () => {
    const sprite = Sprite.parse({ material: { texture: 'dino.png', color: [1, 0, 0], opacity: 0.5 } });
    expect(sprite.tileset?.textureId).toBe('dino.png');
    expect(sprite.uvRect()).toEqual([0, 0, 1, 1]);
    expect(sprite.tint).toEqual([1, 0, 0]);
    expect(sprite.opacity).toBe(0.5);
  });

  it('a legacy animated sprite keeps sampling the very same cells, in order', () => {
    const parent = new Node('root');
    parseNodeJson(parent, {
      type: 'animatedSprite', name: 'fire', id: 'fire-1',
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [],
      sprite: { constraints: 'cylindrical', material: { material: { texture: 'fire.png' } } },
      animation: { columns: 8, rows: 4, fps: 60, loop: true, startFrame: 0, endFrame: 31, sequence: null },
    });

    const node = parent.children[0] as AnimatedSpriteNode;
    expect(node.frames).toHaveLength(32);
    expect(node.fps).toBe(60);
    expect(node.constraints).toBe('cylindrical');
    expect(node.sprite.tileset?.columns).toBe(8);

    // The old grid put frame n at (col, rowFromBottom); the migrated tile must land on the same cell.
    for (let n = 0; n <= 31; n++) {
      const col = n % 8;
      const rowFromBottom = Math.floor(n / 8);
      const tile = node.frames[n];
      expect(tile % 8).toBe(col);
      expect(Math.floor(tile / 8)).toBe(3 - rowFromBottom);
    }
  });

  it('a legacy custom sequence is remapped in place', () => {
    const parent = new Node('root');
    parseNodeJson(parent, {
      type: 'animatedSprite', name: 'a', id: 'a-1',
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [],
      sprite: { constraints: 'free', material: { material: { texture: 'sheet.png' } } },
      animation: { columns: 4, rows: 2, fps: 8, loop: false, sequence: [0, 1, 5, 4] },
    });
    const node = parent.children[0] as AnimatedSpriteNode;
    expect(node.frames).toEqual([4, 5, 1, 0]);
    expect(node.loop).toBe(false);
  });
});

describe('AnimatedSpriteNode playback', () => {
  const nodeWith = (frames: number[], loop: boolean, source: 'node' | 'tile' = 'node') =>
    new AnimatedSpriteNode('a', new Sprite({ tileset: ATLAS() }), { frames, fps: 10, loop, frameSource: source });

  it('advances one frame per 1/fps and loops', () => {
    const node = nodeWith([2, 3, 4], true);
    expect(node.currentTile).toBe(2);
    node.update(0.1, 0.1); expect(node.currentTile).toBe(3);
    node.update(0.1, 0.2); expect(node.currentTile).toBe(4);
    node.update(0.1, 0.3); expect(node.currentTile).toBe(2);
  });

  it('holds the last frame when not looping', () => {
    const node = nodeWith([2, 3], false);
    node.update(0.1, 0.1);
    node.update(0.1, 0.2);
    node.update(0.5, 0.7);
    expect(node.currentTile).toBe(3);
  });

  it('does not advance on a sub-frame delta', () => {
    const node = nodeWith([2, 3], true);
    node.update(0.05, 0.05);
    expect(node.currentTile).toBe(2);
  });

  it('uvRect follows the playing frame', () => {
    const node = nodeWith([2, 3], true);
    node.update(0.1, 0.1);
    expect(node.uvRect()).toEqual([...ATLAS().uvOf(3)]);
  });

  it("the 'tile' source plays the tile's own animation from the tileset", () => {
    const tileset = ATLAS();
    tileset.setMeta(5, { animation: { frames: [5, 6, 7], fps: 10 } });
    const node = new AnimatedSpriteNode('a', new Sprite({ tileset, tileIndex: 5 }), {
      frameSource: 'tile', frames: [], fps: 1, // fps/frames on the node are ignored in this mode
    });
    expect(node.currentTile).toBe(5);
    node.update(0.1, 0.1); expect(node.currentTile).toBe(6);
    node.update(0.1, 0.2); expect(node.currentTile).toBe(7);
    node.update(0.1, 0.3); expect(node.currentTile).toBe(5);
  });

  it('reset returns to the first frame', () => {
    const node = nodeWith([2, 3, 4], true);
    node.update(0.1, 0.1);
    node.reset();
    expect(node.currentTile).toBe(2);
  });
});

describe('round trip', () => {
  it('a static sprite reconstructs its tileset with no library in scope', async () => {
    const parent = new Node('root');
    const original = new SpriteNode('s', new Sprite({ tileset: ATLAS(), tileIndex: 12, tint: [0, 1, 0], opacity: 0.25 }));
    parent.addChild(original);

    const json = await original.serialize();
    const target = new Node('target');
    parseNodeJson(target, json);

    const copy = target.children[0] as SpriteNode;
    expect(copy.tileIndex).toBe(12);
    expect(copy.tint).toEqual([0, 1, 0]);
    expect(copy.opacity).toBe(0.25);
    expect(copy.tileset?.id).toBe('atlas');
    expect(copy.tileset?.margin).toBe(5);
    expect(copy.tileset?.spacing).toBe(2);
    expect(copy.uvRect()).toEqual(original.uvRect());
  });

  it('an animated sprite round-trips its frames, source and tile metadata', async () => {
    const tileset = ATLAS();
    tileset.setMeta(3, { animation: { frames: [3, 4], fps: 5 }, solid: true });
    const parent = new Node('root');
    const original = new AnimatedSpriteNode('a', new Sprite({ tileset, tileIndex: 3 }), {
      frames: [1, 2, 3], frameSource: 'tile', fps: 24, loop: false, constraints: 'cylindrical',
    });
    parent.addChild(original);

    const json = await original.serialize();
    const target = new Node('target');
    parseNodeJson(target, json);

    const copy = target.children[0] as AnimatedSpriteNode;
    expect(copy.frames).toEqual([1, 2, 3]);
    expect(copy.frameSource).toBe('tile');
    expect(copy.fps).toBe(24);
    expect(copy.loop).toBe(false);
    expect(copy.constraints).toBe('cylindrical');
    expect(copy.sprite.tileset?.metaOf(3)?.animation).toEqual({ frames: [3, 4], fps: 5 });
  });

  it('a sprite with no tileset serializes and comes back empty rather than broken', async () => {
    const parent = new Node('root');
    parent.addChild(new SpriteNode('s', new Sprite()));
    const json = await (parent.children[0] as SpriteNode).serialize();
    const target = new Node('target');
    parseNodeJson(target, json);
    const copy = target.children[0] as SpriteNode;
    expect(copy.tileset).toBeNull();
    expect(copy.uvRect()).toEqual([0, 0, 1, 1]);
  });
});
