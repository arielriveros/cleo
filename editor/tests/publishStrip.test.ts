import { describe, it, expect } from 'vitest';
import { stripDimensionData } from '../src/features/publish/stripDimensionData';
import { collectPublishedTextureIds } from '../src/utils/references';

// A serialized scene tree in the shape buildGameData emits: a plain root with typed children.
function scene(): any {
  return {
    name: 'root', id: 'root', type: 'node',
    children: [
      { name: 'Camera', id: 'cam', type: 'camera', children: [] },
      {
        name: 'Landscape', id: 'land', type: 'landscape', children: [
          { name: 'Rock', id: 'rock', type: 'model', children: [] },
        ],
        terrain: { layers: [{ textureId: 'grass.png' }], foliage: [] },
      },
      {
        name: 'Tilemap', id: 'map', type: 'tilemap', children: [],
        tilemap: { layers: [{ tilesetId: 'ts', chunks: [] }], tilesets: [{ id: 'ts', textureId: 'atlas.png' }] },
      },
      {
        name: 'Group', id: 'group', type: 'node', children: [
          { name: 'Nested map', id: 'map2', type: 'tilemap', children: [], tilemap: { layers: [], tilesets: [] } },
        ],
      },
    ],
  };
}

const typesIn = (node: any): string[] => {
  const out: string[] = [];
  const walk = (n: any) => { out.push(n.type); for (const c of n.children ?? []) walk(c); };
  walk(node);
  return out;
};

describe('stripDimensionData', () => {
  it('a 2D scene keeps its tilemaps and loses its landscapes', () => {
    const json = scene();
    expect(stripDimensionData(json, '2D')).toBe(1);
    const types = typesIn(json);
    expect(types).toContain('tilemap');
    expect(types).not.toContain('landscape');
  });

  it('a 3D scene keeps its landscapes and loses its tilemaps, at any depth', () => {
    const json = scene();
    expect(stripDimensionData(json, '3D')).toBe(2);
    const types = typesIn(json);
    expect(types).toContain('landscape');
    expect(types).not.toContain('tilemap');
  });

  it('takes the dead node’s whole subtree with it', () => {
    const json = scene();
    stripDimensionData(json, '2D');
    // The rock was placed on terrain that no longer exists; leaving it would float it over nothing.
    expect(typesIn(json)).not.toContain('model');
  });

  it('is a no-op on a scene with neither', () => {
    const json = { type: 'node', children: [{ type: 'camera', children: [] }] };
    expect(stripDimensionData(json, '2D')).toBe(0);
    expect(stripDimensionData(json, '3D')).toBe(0);
    expect(json.children).toHaveLength(1);
  });

  it('runs before the texture walker, so a stripped subtree ships none of its textures', () => {
    // This ordering is the whole point of the feature: the walker is driven off the SERIALIZED tree, so
    // stripping afterwards would still drag a discarded landscape's layer textures into the build.
    const json = scene();
    stripDimensionData(json, '2D');
    const kept = new Set<string>();
    collectPublishedTextureIds(json, kept);
    expect(kept.has('atlas.png')).toBe(true);
    expect(kept.has('grass.png')).toBe(false);
  });

  it('a 3D scene ships its terrain textures and none of its tileset atlases', () => {
    const json = scene();
    stripDimensionData(json, '3D');
    const kept = new Set<string>();
    collectPublishedTextureIds(json, kept);
    expect(kept.has('grass.png')).toBe(true);
    expect(kept.has('atlas.png')).toBe(false);
  });
});

describe('collectPublishedTextureIds — tilemaps', () => {
  it('finds an embedded tileset’s atlas, which sits outside any `textures` map', () => {
    const kept = new Set<string>();
    collectPublishedTextureIds(scene(), kept);
    expect(kept.has('atlas.png')).toBe(true);
  });

  it('walks nested tilemaps', () => {
    const json = {
      type: 'node',
      children: [{
        type: 'node',
        children: [{ type: 'tilemap', tilemap: { tilesets: [{ id: 'a', textureId: 'deep.png' }] }, children: [] }],
      }],
    };
    const kept = new Set<string>();
    collectPublishedTextureIds(json, kept);
    expect(kept.has('deep.png')).toBe(true);
  });

  it('tolerates a tilemap with no tilesets at all', () => {
    const kept = new Set<string>();
    expect(() => collectPublishedTextureIds({ type: 'tilemap', tilemap: {}, children: [] }, kept)).not.toThrow();
  });
});
