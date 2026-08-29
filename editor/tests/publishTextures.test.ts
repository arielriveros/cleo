import { describe, it, expect } from 'vitest';
import { collectPublishedTextureIds } from '../src/utils/references';

/**
 * Publishing now ships only the textures the scenes reference, instead of the entire TextureManager.
 *
 * The failure mode is asymmetric and silent: an id this walker misses is a texture the published game
 * renders white or magenta, with nothing in the build log to say so. These cases are therefore pinned
 * individually — every one of them is a path that lives OUTSIDE a plain node material.
 */

const ids = (node: any): string[] => {
  const set = new Set<string>();
  collectPublishedTextureIds(node, set);
  return [...set].sort();
};

describe('published texture references', () => {
  it('finds plain node material textures, at any depth', () => {
    expect(ids({
      children: [{ children: [{ model: { material: { textures: { baseTexture: 'a', normalMap: 'b' } } }, children: [] }] }],
    })).toEqual(['a', 'b']);
  });

  it('finds a UI image’s texture, which hangs off its `ui` payload', () => {
    // A uiImage holds a bare texture id on `ui.textureId` — no material, no tileset — so the generic
    // walk cannot see it. Missing it publishes a game whose HUD images are blank.
    expect(ids({
      children: [
        { type: 'uiRoot', ui: { textureId: null }, children: [
          { type: 'uiImage', ui: { textureId: 'hud-icon' }, children: [] },
          { type: 'uiPanel', ui: {}, children: [
            { type: 'uiImage', ui: { textureId: 'nested-icon' }, children: [] },
          ] },
        ] },
      ],
    })).toEqual(['hud-icon', 'nested-icon']);
  });

  it('finds a tilemap’s and a sprite’s embedded atlases', () => {
    // Both hide their atlas id on an embedded tileset rather than in a `textures` map, so the generic
    // deep walk cannot see them. A tilemap embeds an ARRAY; a sprite embeds a single object — missing
    // either one publishes a game whose tiles or sprites render untextured.
    expect(ids({
      children: [
        { nodeType: 'tilemap', tilemap: { tilesets: [{ textureId: 'atlas.png' }] }, children: [] },
        { nodeType: 'sprite', sprite: { tileset: { textureId: 'hero.png' } }, children: [] },
        { nodeType: 'animatedSprite', sprite: { tileset: { textureId: 'fire.png' } }, children: [] },
      ],
    })).toEqual(['atlas.png', 'fire.png', 'hero.png']);
  });

  it('finds a camera’s inline screen-material textures', () => {
    // screenMaterials serialize inline on the CameraNode (node.ts CameraNode.serialize), so they are
    // only reachable through the generic deep walk — there is no node.model here at all.
    expect(ids({
      children: [{ nodeType: 'camera', screenMaterials: [{ textures: { noise: 'grain' } }], children: [] }],
    })).toEqual(['grain']);
  });

  it('finds a terrain layer height map in the LEGACY top-level shape', () => {
    // Terrain used to serialize its height map as a top-level sibling of `textures`, because
    // Material.serialize()'s basic/blinn_phong branches had no displacement slot to put it in. Asset
    // JSON on disk is never rewritten until the user re-saves that asset — the shipped 3d-example is
    // still in this shape — so the collector must keep understanding it. Missing it flags the texture
    // as orphaned and omits it from published builds, which breaks the layer permanently.
    expect(ids({
      children: [{
        terrain: {
          layers: [{ material: { textures: { baseColorTexture: 'rock' }, displacementMap: 'rock_h' } }],
        },
        children: [],
      }],
    })).toEqual(['rock', 'rock_h']);
  });

  it('finds a terrain layer height map in the CURRENT `textures` shape', () => {
    // Every material type carries a `displacementMap` slot now, so a fresh save puts the id in the
    // textures map like any other — where the generic deep walk finds it with no special case.
    expect(ids({
      children: [{
        terrain: {
          layers: [{ material: { textures: { baseColorTexture: 'rock', displacementMap: 'rock_h' } } }],
        },
        children: [],
      }],
    })).toEqual(['rock', 'rock_h']);
  });

  it('finds foliage LOD and billboard-impostor textures on a terrain material rule', () => {
    // The exact regression this guards: a texture used ONLY by a distant foliage LOD or by the impostor.
    expect(ids({
      children: [{
        terrain: {
          layers: [{
            material: {
              foliageInclude: [{
                kind: 'mesh', name: 'oak',
                models: [{ material: { textures: { baseTexture: 'bark' } } }],
                lods: [{ models: [{ material: { textures: { baseTexture: 'bark_lod2' } } }], distance: 40 }],
                billboard: { textureId: 'oak_impostor', distance: 80 },
              }],
            },
          }],
        },
        children: [],
      }],
    })).toEqual(['bark', 'bark_lod2', 'oak_impostor']);
  });

  it('finds textures on a scattered foliage layer, not just on the rule', () => {
    expect(ids({
      children: [{
        terrain: { foliage: [{ kind: 'billboard', name: 'grass', textureId: 'grass_tex' }] },
        children: [],
      }],
    })).toEqual(['grass_tex']);
  });

  it('finds a legacy plain-albedo terrain layer', () => {
    expect(ids({ children: [{ terrain: { layers: [{ textureId: 'old_dirt' }] }, children: [] }] }))
      .toEqual(['old_dirt']);
  });

  it('survives nulls and empty trees without throwing', () => {
    expect(ids(null)).toEqual([]);
    expect(ids({ children: [null, { terrain: null, children: null }] })).toEqual([]);
    expect(ids({ terrain: { layers: [null], foliage: undefined }, children: [] })).toEqual([]);
  });
});
