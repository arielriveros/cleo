import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TEXTURE_SETTINGS, buildTextureAsset, withSource, toTextureConfig, fromTextureConfig,
  reconcileTextureAssets, imageIdsMissingSize,
} from '../src/utils/textureAssets';
import type { TextureAsset, TextureSettings, LiveTexture } from '../src/utils/textureAssets';
import { buildImageAsset, withImageSize } from '../src/utils/images';
import type { ImageAsset } from '../src/utils/images';

// The pure half of the image/texture split: what a stored config means, and how the libraries are brought
// back in line with what is actually registered. Everything here decides whether a project saved before
// the split still renders the way it did.

const liveOf = (init: Partial<LiveTexture> & Pick<LiveTexture, 'id'>): LiveTexture => ({
  config: undefined,
  width: 256,
  height: 256,
  source: { mime: 'image/png', byteLength: 1024 },
  ...init,
});

describe('fromTextureConfig — what a legacy config meant', () => {
  // The four shapes actually written by the code that existed before the split.
  it('reads the bare `{ wrapping: repeat }` every import path hardcoded', () => {
    const s = fromTextureConfig({ wrapping: 'repeat' });
    expect([s.wrapU, s.wrapV, s.wrapW]).toEqual(['repeat', 'repeat', 'repeat']);
    expect(s.mipMap).toBe(true);          // absent mipMap meant true in the Texture constructor
    expect(s.minFilter).toBe('linear');
    expect(s.magFilter).toBe('linear');
    expect(s.anisotropy).toBe(1);
  });

  // The glTF/assimp route passes this, which is why imported model textures have no mipmaps. It has to
  // survive as false, or the split would silently "fix" every imported model and change how it renders.
  it('preserves the glTF route\'s mipMap: false', () => {
    expect(fromTextureConfig({ wrapping: 'repeat', mipMap: false }).mipMap).toBe(false);
  });

  // The engine's own default is clamp. Only the editor's import paths ever said repeat, explicitly.
  it('defaults an absent wrapping to clamp, not to the import paths\' repeat', () => {
    const s = fromTextureConfig({});
    expect([s.wrapU, s.wrapV, s.wrapW]).toEqual(['clamp', 'clamp', 'clamp']);
  });

  it('tolerates undefined and junk', () => {
    expect(fromTextureConfig(undefined)).toEqual(fromTextureConfig({}));
    expect(fromTextureConfig(null)).toEqual(fromTextureConfig({}));
    expect(fromTextureConfig({ wrapping: 'nonsense', minFilter: 7, anisotropy: 'x' }).wrapU).toBe('clamp');
    expect(fromTextureConfig({ anisotropy: 'x' }).anisotropy).toBe(1);
  });

  // Minification was forced to the mip filter before the two became independent.
  it('reads a pre-split config\'s minFilter as the fused mip filter', () => {
    expect(fromTextureConfig({ mipMapFilter: 'nearest' }).minFilter).toBe('nearest');
    expect(fromTextureConfig({ mipMapFilter: 'nearest', minFilter: 'linear' }).minFilter).toBe('linear');
  });

  it('lets per-axis wrap override the shorthand', () => {
    const s = fromTextureConfig({ wrapping: 'repeat', wrapV: 'clamp' });
    expect([s.wrapU, s.wrapV]).toEqual(['repeat', 'clamp']);
  });
});

describe('flipY — the one inversion in the codebase', () => {
  // TextureConfig.flipY === false MEANS flipped, and is the default, so the positive spelling is true.
  it('inverts in both directions', () => {
    expect(toTextureConfig({ ...DEFAULT_TEXTURE_SETTINGS, flipY: true }).flipY).toBe(false);
    expect(toTextureConfig({ ...DEFAULT_TEXTURE_SETTINGS, flipY: false }).flipY).toBe(true);
    expect(fromTextureConfig({ flipY: false }).flipY).toBe(true);
    expect(fromTextureConfig({ flipY: true }).flipY).toBe(false);
  });

  // The case that matters: every texture in every project saved to date has flipY absent or false, and
  // must keep flipping. If this ever reads false, every existing texture renders upside down.
  it('keeps every pre-split texture flipped', () => {
    expect(fromTextureConfig({ wrapping: 'repeat' }).flipY).toBe(true);
    expect(fromTextureConfig(undefined).flipY).toBe(true);
    expect(DEFAULT_TEXTURE_SETTINGS.flipY).toBe(true);
    expect(toTextureConfig(DEFAULT_TEXTURE_SETTINGS).flipY).toBe(false);
  });
});

describe('settings <-> config round-trip', () => {
  it('survives a full round-trip unchanged', () => {
    const settings: TextureSettings = {
      wrapU: 'repeat', wrapV: 'clamp', wrapW: 'mirror',
      minFilter: 'nearest', magFilter: 'nearest',
      mipMap: true, mipMapFilter: 'nearest',
      anisotropy: 8, lodMin: 1, lodMax: 6,
      flipY: false, precision: 'high', colorSpace: 'srgb',
    };
    expect(fromTextureConfig(toTextureConfig(settings))).toEqual(settings);
  });

  it('round-trips the defaults', () => {
    expect(fromTextureConfig(toTextureConfig(DEFAULT_TEXTURE_SETTINGS))).toEqual(DEFAULT_TEXTURE_SETTINGS);
  });

  // A reader older than the per-axis fields — an exported bundle opened by a previous build, a published
  // pack — falls back to `wrapping`, so it must carry the U axis rather than a default.
  it('emits the legacy `wrapping` shorthand alongside the per-axis fields', () => {
    const c = toTextureConfig({ ...DEFAULT_TEXTURE_SETTINGS, wrapU: 'mirror', wrapV: 'clamp' });
    expect(c.wrapping).toBe('mirror');
    expect(c.wrapU).toBe('mirror');
    expect(c.wrapV).toBe('clamp');
  });

  // Anisotropy is stored as authored, not clamped: the device limit belongs to the machine, so opening a
  // project once on a weak GPU must not flatten 16x to 4x on disk. resolveSampler clamps at bind time.
  it('stores anisotropy unclamped', () => {
    expect(toTextureConfig({ ...DEFAULT_TEXTURE_SETTINGS, anisotropy: 16 }).anisotropy).toBe(16);
  });

  it('omits absent LOD clamps rather than writing zeros', () => {
    const c = toTextureConfig(DEFAULT_TEXTURE_SETTINGS);
    expect('lodMin' in c).toBe(false);
    expect('lodMax' in c).toBe(false);
  });
});

describe('buildTextureAsset / withSource', () => {
  it('carries the duplicated id lists the reference walkers scan', () => {
    const a = buildTextureAsset('rock.png', 'rock', { kind: 'image', imageId: 'rock.png' });
    expect(a.textureIds).toEqual(['rock.png']);
    expect(a.imageIds).toEqual(['rock.png']);
  });

  // A pack depends on the textures it reads channels from; a bundle that ships the pack must ship them.
  it('lists a pack\'s channel sources in textureIds', () => {
    const a = buildTextureAsset('orm', 'ORM', {
      kind: 'pack',
      spec: {
        r: { textureId: 'ao.png', channel: 0 },
        g: { textureId: 'rough.png', channel: 0 },
        b: { textureId: 'metal.png', channel: 0 },
        a: { constant: 1 },
      },
    });
    expect(a.textureIds).toEqual(['orm', 'ao.png', 'rough.png', 'metal.png']);
    expect(a.imageIds).toEqual([]); // nothing baked yet
  });

  it('re-derives the lists when the source changes', () => {
    const a = buildTextureAsset('t', 't', { kind: 'image', imageId: 'a.png' });
    const b = withSource(a, { kind: 'image', imageId: 'b.png' });
    expect(b.imageIds).toEqual(['b.png']);
    expect(a.imageIds).toEqual(['a.png']); // not mutated
  });

  it('gives a runtime source no image', () => {
    const a = buildTextureAsset('builtin', 'builtin', { kind: 'runtime' });
    expect(a.imageIds).toEqual([]);
    expect(a.textureIds).toEqual(['builtin']);
  });
});

describe('reconcileTextureAssets', () => {
  it('mints an image and a texture under the SAME id, which is what moves no bytes', () => {
    const r = reconcileTextureAssets([liveOf({ id: 'rock.png' })], [], []);
    expect(r.changed).toBe(true);
    expect(r.images.map(i => i.id)).toEqual(['rock.png']);
    expect(r.textures.map(t => t.id)).toEqual(['rock.png']);
    expect(r.textures[0].source).toEqual({ kind: 'image', imageId: 'rock.png' });
    // The id keeps its extension — materials reference it — but the display name is the stem.
    expect(r.textures[0].name).toBe('rock');
  });

  it('is idempotent over repeated passes', () => {
    const live = [liveOf({ id: 'a.png' }), liveOf({ id: 'b.png' })];
    const first = reconcileTextureAssets(live, [], []);
    const second = reconcileTextureAssets(live, first.images, first.textures);
    const third = reconcileTextureAssets(live, second.images, second.textures);
    expect(second.changed).toBe(false);
    expect(third.changed).toBe(false);
    // Same array identity, so assigning the result unconditionally cannot cause a render.
    expect(second.images).toBe(first.images);
    expect(second.textures).toBe(first.textures);
  });

  // Path-loaded (glTF external URI) and built-in textures have no retained bytes. They still need a
  // texture record so their sampling is authorable and the VFS does not judge them orphaned.
  it('gives a texture with no retained bytes a runtime source and no image', () => {
    const r = reconcileTextureAssets([liveOf({ id: 'external.png', source: null })], [], []);
    expect(r.images).toEqual([]);
    expect(r.textures[0].source).toEqual({ kind: 'runtime' });
  });

  it('carries the live config into the authored settings', () => {
    const r = reconcileTextureAssets(
      [liveOf({ id: 'x.png', config: { wrapping: 'repeat', mipMap: false } })], [], []);
    expect(r.textures[0].settings.wrapU).toBe('repeat');
    expect(r.textures[0].settings.mipMap).toBe(false);
  });

  it('leaves an already-known texture alone', () => {
    const existing: TextureAsset[] = [
      buildTextureAsset('rock.png', 'renamed by the user', { kind: 'image', imageId: 'rock.png' }),
    ];
    const images: ImageAsset[] = [buildImageAsset({ id: 'rock.png', name: 'rock.png', mime: 'image/png' })];
    const r = reconcileTextureAssets([liveOf({ id: 'rock.png' })], images, existing);
    expect(r.changed).toBe(false);
    expect(r.textures[0].name).toBe('renamed by the user');
  });

  // The duplicate-for-a-second-sampler case: two textures, one image, and no second copy of the bytes.
  it('does not re-mint an image a second texture already shares', () => {
    const images: ImageAsset[] = [buildImageAsset({ id: 'rock.png', name: 'rock.png', mime: 'image/png' })];
    const textures: TextureAsset[] = [
      buildTextureAsset('rock.png', 'rock', { kind: 'image', imageId: 'rock.png' }),
      buildTextureAsset('rock_tiled', 'rock tiled', { kind: 'image', imageId: 'rock.png' }),
    ];
    const live = [liveOf({ id: 'rock.png' }), liveOf({ id: 'rock_tiled' })];
    const r = reconcileTextureAssets(live, images, textures);
    expect(r.changed).toBe(false);
    expect(r.images).toHaveLength(1);
  });

  // An LOD downscale is a real, persisted, referenced texture — it must get records like any other.
  it('handles a derived __lod texture like any other', () => {
    const r = reconcileTextureAssets([liveOf({ id: 'rock.png__lod256' })], [], []);
    expect(r.textures.map(t => t.id)).toEqual(['rock.png__lod256']);
  });

  it('ignores a blank id', () => {
    expect(reconcileTextureAssets([liveOf({ id: '' })], [], []).changed).toBe(false);
  });
});

describe('image size backfill', () => {
  it('reports which images still need decoding', () => {
    const images = [
      buildImageAsset({ id: 'a', mime: 'image/png', width: 8, height: 8 }),
      buildImageAsset({ id: 'b', mime: 'image/png' }),
    ];
    expect(imageIdsMissingSize(images)).toEqual(['b']);
  });

  it('fills a size in, and returns the same array when nothing changed', () => {
    const images = [buildImageAsset({ id: 'b', mime: 'image/png' })];
    const filled = withImageSize(images, 'b', 64, 32);
    expect(filled[0]).toMatchObject({ width: 64, height: 32 });
    expect(withImageSize(filled, 'b', 64, 32)).toBe(filled);
    expect(withImageSize(filled, 'missing', 1, 1)).toBe(filled);
    expect(withImageSize(filled, 'b', 0, 0)).toBe(filled); // an undecoded image reports 0
  });
});
