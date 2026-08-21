import { describe, it, expect } from 'vitest';
import { remapDeep, type Remaps } from '../editor/src/utils/bundleMerge';

// Importing a bundle into a project that already owns some of its asset ids re-mints the collisions and
// then rewrites every reference to them. The dangerous half is the EMBEDDED copies: a link is remapped
// but its embedded twin is not, and the result draws nothing with no error anywhere.

const remaps = (over: Partial<Remaps> = {}): Remaps => ({
  tex: new Map(), mat: new Map(), tmat: new Map(), tpl: new Map(),
  model: new Map(), script: new Map(), afield: new Map(), anim: new Map(), tileset: new Map(),
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

describe('remapDeep — the JSON-string id LISTS', () => {
  // Two node variables hold a list of asset ids, and the variable system has no array type, so both are
  // stored with JSON.stringify. `__screenMaterialIds` was remapped behind an `Array.isArray(value)` guard
  // that therefore never fired, and `__materialIds` — one material per submesh of a merged model — was not
  // handled at all. Either way the ids kept pointing at the pre-import values and the links dangled.
  const mat = () => new Map([['old-mat', 'new-mat']]);
  const varsOf = (name: string, value: any) => ({ variables: { [name]: { type: 'string', value } } });

  it('remaps every entry of __materialIds and leaves the rest of the list alone', () => {
    const node: any = varsOf('__materialIds', JSON.stringify(['old-mat', 'untouched']));
    remapDeep(node, remaps({ mat: mat() }));
    expect(JSON.parse(node.variables.__materialIds.value)).toEqual(['new-mat', 'untouched']);
  });

  it('remaps __screenMaterialIds, which the Array.isArray guard used to skip entirely', () => {
    const node: any = varsOf('__screenMaterialIds', JSON.stringify(['old-mat']));
    remapDeep(node, remaps({ mat: mat() }));
    expect(JSON.parse(node.variables.__screenMaterialIds.value)).toEqual(['new-mat']);
  });

  it('keeps __materialId and __materialIds in step — they name the same asset at slot 0', () => {
    const node: any = {
      variables: {
        __materialId: { type: 'string', value: 'old-mat' },
        __materialIds: { type: 'string', value: JSON.stringify(['old-mat', 'other']) },
      },
    };
    remapDeep(node, remaps({ mat: mat() }));
    expect(node.variables.__materialId.value).toBe('new-mat');
    expect(JSON.parse(node.variables.__materialIds.value)[0]).toBe('new-mat');
  });

  it('still handles a bare array, as an older bundle may hold', () => {
    const node: any = varsOf('__screenMaterialIds', ['old-mat']);
    remapDeep(node, remaps({ mat: mat() }));
    expect(node.variables.__screenMaterialIds.value).toEqual(['new-mat']);
  });

  it('leaves a corrupt list untouched rather than inventing one', () => {
    const node: any = varsOf('__materialIds', '{not json');
    expect(() => remapDeep(node, remaps({ mat: mat() }))).not.toThrow();
    expect(node.variables.__materialIds.value).toBe('{not json');
  });

  it('does nothing when the variable is absent', () => {
    const node: any = { variables: {} };
    remapDeep(node, remaps({ mat: mat() }));
    expect(node.variables.__materialIds).toBeUndefined();
  });
});
