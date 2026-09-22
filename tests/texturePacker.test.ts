import { describe, expect, it } from 'vitest';
import { TexturePacker, PackSpec } from '../src/graphics/systems/texturePacker';

/**
 * The packed texture's WRAP MODE belongs to the caller, not to whichever source happens to be first.
 *
 * A pack is sampled at the CALLER's tiling, and its sources' own wrap modes say nothing about that.
 * `Texture` defaults to `clamp`; a terrain layer samples its pack at `baseUv * u_tiling{i}` with tiling
 * typically 20-50. Inheriting `clamp` therefore showed one instance of the normal+height in the first
 * tile and a stretched edge texel across the whole rest of the terrain — the height appearing tens of
 * times larger than the albedo beside it, which repeats. That is the "way too big / doesn't align with
 * the other maps" report, and nothing about the source textures looks wrong when you inspect them.
 *
 * The key matters as much as the field: the wrap mode is baked into the output's sampler, so without it
 * in the key the first caller to request a given source/channel combination silently decides the mode
 * for every later one.
 */

const specKey = (spec: PackSpec): string => (TexturePacker.Instance as any)._specKey(spec);

const base = (): PackSpec => ({
    r: { textureId: 'normal', channel: 0 },
    g: { textureId: 'normal', channel: 1 },
    b: { textureId: 'normal', channel: 2 },
    a: { textureId: 'height', channel: 0 },
});

describe('the cache key', () => {
    it('separates two specs that differ only in wrapping', () => {
        expect(specKey({ ...base(), wrapping: 'repeat' }))
            .not.toBe(specKey({ ...base(), wrapping: 'clamp' }));
    });

    it('is stable for the same spec', () => {
        expect(specKey({ ...base(), wrapping: 'repeat' })).toBe(specKey({ ...base(), wrapping: 'repeat' }));
    });

    it('distinguishes an unstated wrapping from a stated one', () => {
        // "inherit from the sources" and "repeat" can resolve to different textures, so they cannot
        // share a cache entry even when the sources are identical.
        expect(specKey(base())).not.toBe(specKey({ ...base(), wrapping: 'repeat' }));
    });

    it('still separates different sources and channels', () => {
        const other = { ...base(), a: { textureId: 'height2', channel: 0 } } as PackSpec;
        expect(specKey(base())).not.toBe(specKey(other));
        const chan = { ...base(), a: { textureId: 'height', channel: 1 } } as PackSpec;
        expect(specKey(base())).not.toBe(specKey(chan));
    });

    it('separates a constant channel from a sourced one', () => {
        const flat = { ...base(), a: { constant: 0.0, ignored: true } } as PackSpec;
        expect(specKey(base())).not.toBe(specKey(flat));
    });
});

describe('terrain states its wrap mode rather than inheriting it', () => {
    it("asks for repeat, for both of a surface's packs", async () => {
        // A landscape surface is tiled across the whole terrain, so its packs must repeat; inheriting a
        // source's clamp would show one tile and a stretched edge over the rest. The specs are built in
        // terrain/terrainSurfaceArrays.ts and baked into array layers.
        const { albedoPackSpec, normalPackSpec } = await import('../src/terrain/terrainSurfaceArrays');
        const surface = { albedoId: 'a', aoId: null, normalId: 'n', heightId: 'h', invertHeight: false,
                          color: [1, 1, 1], metallic: 0, roughness: 1, tiling: 20 };
        expect(albedoPackSpec(surface).wrapping).toBe('repeat');
        expect(normalPackSpec(surface).wrapping).toBe('repeat');
    });
});
