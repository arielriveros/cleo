import { describe, it, expect } from 'vitest';
import { remapDeep, type Remaps } from '../editor/src/utils/bundleMerge';

// Importing a bundle into a project that already owns some of its asset ids re-mints the collisions and
// then rewrites every reference to them. The dangerous half is the EMBEDDED copies: a link is remapped
// but its embedded twin is not, and the result draws nothing with no error anywhere.

const remaps = (over: Partial<Remaps> = {}): Remaps => ({
  tex: new Map(), mat: new Map(), tmat: new Map(), tpl: new Map(),
  model: new Map(), script: new Map(), afield: new Map(), tileset: new Map(),
  ...over,
});

describe('remapDeep — tileset references', () => {
  const tileset = () => new Map([['old-ts', 'new-ts']]);

  it("moves a tilemap layer's link and its embedded copy together", () => {
    const node = {
      tilemap: {
        layers: [{ cfg: { tilesetId: 'old-ts' } }],
        tilesets: [{ id: 'old-ts', textureId: 'atlas.png' }],
      },
    };
    remapDeep(node, remaps({ tileset: tileset() }));
    expect(node.tilemap.layers[0].cfg.tilesetId).toBe('new-ts');
    expect(node.tilemap.tilesets[0].id).toBe('new-ts');
  });

  it("moves a sprite's link and its singular embedded copy together", () => {
    // A sprite embeds ONE tileset under the singular `tileset` key, which the array branch never matches.
    const node = { sprite: { tilesetId: 'old-ts', tileset: { id: 'old-ts', textureId: 'hero.png' } } };
    remapDeep(node, remaps({ tileset: tileset() }));
    expect(node.sprite.tilesetId).toBe('new-ts');
    expect(node.sprite.tileset.id).toBe('new-ts');
  });

  it("follows the atlas texture re-mint into a sprite's embedded tileset", () => {
    const node = { sprite: { tileset: { id: 'ts', textureId: 'hero.png' } } };
    remapDeep(node, remaps({ tex: new Map([['hero.png', 'hero_1.png']]) }));
    expect(node.sprite.tileset.textureId).toBe('hero_1.png');
  });

  it('leaves ids with no collision alone', () => {
    const node = { sprite: { tilesetId: 'keep', tileset: { id: 'keep', textureId: 'a.png' } } };
    remapDeep(node, remaps({ tileset: tileset() }));
    expect(node.sprite.tilesetId).toBe('keep');
    expect(node.sprite.tileset.id).toBe('keep');
  });
});
