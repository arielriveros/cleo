import { describe, it, expect, vi } from 'vitest';

// The pure half of LOD texture generation: how derived ids are formed, how the size ladder floors, and
// how a material asset is repointed at the twins.
//
// `cleo` and the browser halves (canvas, IndexedDB) are mocked out — what matters here is that two
// levels landing on the same size SHARE an id (so the images are not duplicated), that regeneration is
// idempotent, and that a repointed material carries a textureIds list rebuilt from the NEW slots rather
// than copied from the source.

vi.mock('cleo', () => ({ TextureManager: { Instance: { getTexture: () => null, addTextureFromData: () => {} } } }));
vi.mock('../src/utils/textureReady', () => ({ awaitTextureImage: async () => null }));
vi.mock('../src/utils/textureStore', () => ({ persistTextures: async () => 0 }));

const { lodTextureId, halveTo, materialAssetWithTextures, MIN_LOD_TEXTURE_SIZE } =
  await import('../src/utils/lodTextures');

describe('lodTextureId', () => {
  it('is deterministic, so regenerating reuses rather than leaks', () => {
    expect(lodTextureId('bark', 512)).toBe(lodTextureId('bark', 512));
  });

  it('keys on the size, so two levels at the same size share one image', () => {
    expect(lodTextureId('bark', 512)).toBe(lodTextureId('bark', 512));
    expect(lodTextureId('bark', 512)).not.toBe(lodTextureId('bark', 256));
  });

  it('does not use the derived-texture prefix, which is excluded from persistence', () => {
    expect(lodTextureId('bark', 512).startsWith('__packed__')).toBe(false);
  });
});

describe('halveTo', () => {
  it('halves once per level', () => {
    expect(halveTo(2048, 1)).toBe(1024);
    expect(halveTo(2048, 2)).toBe(512);
    expect(halveTo(2048, 3)).toBe(256);
  });

  it('stays power-of-two when the source was', () => {
    for (let level = 1; level <= 4; level++) {
      const v = halveTo(1024, level);
      expect(Number.isInteger(Math.log2(v))).toBe(true);
    }
  });

  it('floors rather than destroying a small map', () => {
    expect(halveTo(128, 5)).toBe(MIN_LOD_TEXTURE_SIZE);
    expect(halveTo(64, 3)).toBe(MIN_LOD_TEXTURE_SIZE);
  });

  it('never enlarges, and never floors a map that started below the floor', () => {
    // A 32px map is already smaller than the floor; clamping UP to 64 would invent detail.
    expect(halveTo(32, 2)).toBeLessThanOrEqual(32);
    expect(halveTo(2048, 0)).toBe(2048);
  });
});

describe('materialAssetWithTextures', () => {
  const source = {
    id: 'mat-1',
    name: 'Bark',
    thumbnail: 'thumb',
    textureIds: ['bark_albedo', 'bark_normal'],
    material: {
      type: 'pbr',
      baseColor: [1, 1, 1],
      textures: { baseColorTexture: 'bark_albedo', normalMap: 'bark_normal', maskMap: '' },
    },
  } as any;

  const ids = new Map([['bark_albedo', 'bark_albedo__lod512'], ['bark_normal', 'bark_normal__lod512']]);

  it('repoints every slot that has a twin', () => {
    const out = materialAssetWithTextures(source, ids, 'Bark LOD1');
    expect(out.material.textures.baseColorTexture).toBe('bark_albedo__lod512');
    expect(out.material.textures.normalMap).toBe('bark_normal__lod512');
  });

  it('leaves a slot with no twin pointing at its source', () => {
    const partial = new Map([['bark_albedo', 'bark_albedo__lod512']]);
    const out = materialAssetWithTextures(source, partial, 'Bark LOD1');
    expect(out.material.textures.normalMap).toBe('bark_normal');
  });

  it('rebuilds textureIds from the NEW slots, never copying the source list', () => {
    // Copying would leave the level advertising the full-size ids, which is what the bundle and the
    // texture store both read to decide what to keep.
    const out = materialAssetWithTextures(source, ids, 'Bark LOD1');
    expect(out.textureIds).toEqual(['bark_albedo__lod512', 'bark_normal__lod512']);
    expect(out.textureIds).not.toContain('bark_albedo');
  });

  it('mints a NEW asset id — the level may not share the source material', () => {
    // resolveMaterialRefs overwrites an embedded material from the library by __materialId, so sharing
    // the id would throw the repointing away at instantiation and draw at full resolution.
    const out = materialAssetWithTextures(source, ids, 'Bark LOD1');
    expect(out.id).not.toBe(source.id);
    expect(out.name).toBe('Bark LOD1');
  });

  it('does not mutate the source asset', () => {
    materialAssetWithTextures(source, ids, 'Bark LOD1');
    expect(source.material.textures.baseColorTexture).toBe('bark_albedo');
    expect(source.textureIds).toEqual(['bark_albedo', 'bark_normal']);
  });

  it('skips empty slots without inventing an id for them', () => {
    const out = materialAssetWithTextures(source, ids, 'Bark LOD1');
    expect(out.material.textures.maskMap).toBe('');
    expect(out.textureIds).not.toContain('');
  });

  it('survives a material with no textures map at all', () => {
    const bare = { id: 'm', name: 'Flat', thumbnail: '', material: { type: 'pbr' } } as any;
    const out = materialAssetWithTextures(bare, ids, 'Flat LOD1');
    expect(out.textureIds).toEqual([]);
  });
});
