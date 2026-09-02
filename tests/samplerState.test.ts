import { describe, it, expect } from 'vitest';
import { resolveSampler, samplerKey, DEFAULT_RESOLVED_SAMPLER } from '../src/graphics/rhi/samplerState';
import { glMinFilter, glMagFilter, glAddressMode, GL_ENUMS } from '../src/graphics/rhi/webgl2/glEnums';
import type { TextureConfigureDescriptor } from '../src/graphics/rhi/types';

// The sampler rules, which decide what a texture LOOKS like and two of which are device-fatal when
// broken. Pure, so this runs with no GPU — the reason they live outside the backends at all.

const base: TextureConfigureDescriptor = {
    format: 'rgba8unorm',
    addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'clamp-to-edge',
    minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear',
    maxAnisotropy: 1, flipY: true, isDepth: false,
};
const colour = { isDepth: false, compare: false, maxAnisotropy: 16 };

describe('resolveSampler — anisotropy', () => {
    it('passes an anisotropy request through when every filter is linear', () => {
        expect(resolveSampler({ ...base, maxAnisotropy: 8 }, colour).maxAnisotropy).toBe(8);
    });

    // WebGPU REJECTS such a sampler, and a rejected sampler takes down the bind group naming it. The
    // texture editor lets a user pick nearest AND 16x, so this cannot be a caller's responsibility.
    it('forces anisotropy back to 1 unless minification, magnification and mip are all linear', () => {
        const a = 16;
        expect(resolveSampler({ ...base, maxAnisotropy: a, magFilter: 'nearest' }, colour).maxAnisotropy).toBe(1);
        expect(resolveSampler({ ...base, maxAnisotropy: a, minFilter: 'nearest' }, colour).maxAnisotropy).toBe(1);
        expect(resolveSampler({ ...base, maxAnisotropy: a, mipmapFilter: 'nearest' }, colour).maxAnisotropy).toBe(1);
        // No mip chain at all is the case the old fused filter could not even spell.
        expect(resolveSampler({ ...base, maxAnisotropy: a, mipmapFilter: null }, colour).maxAnisotropy).toBe(1);
    });

    it('clamps to the device limit and rounds to whole taps', () => {
        expect(resolveSampler({ ...base, maxAnisotropy: 64 }, colour).maxAnisotropy).toBe(16);
        expect(resolveSampler({ ...base, maxAnisotropy: 3.6 }, colour).maxAnisotropy).toBe(4);
        expect(resolveSampler({ ...base, maxAnisotropy: 0 }, colour).maxAnisotropy).toBe(1);
        expect(resolveSampler({ ...base, maxAnisotropy: -8 }, colour).maxAnisotropy).toBe(1);
        // A device without EXT_texture_filter_anisotropic reports 1, and must not be exceeded.
        expect(resolveSampler({ ...base, maxAnisotropy: 16 }, { ...colour, maxAnisotropy: 1 }).maxAnisotropy).toBe(1);
    });
});

describe('resolveSampler — depth', () => {
    it('forces a plainly-sampled depth texture to a non-filtering sampler', () => {
        const r = resolveSampler(base, { isDepth: true, compare: false, maxAnisotropy: 16 });
        expect(r.minFilter).toBe('nearest');
        expect(r.magFilter).toBe('nearest');
        expect(r.mipmapFilter).toBeNull();
        expect(r.maxAnisotropy).toBe(1);
    });

    // PCF is the whole point of a comparison sampler, so this one filters.
    it('lets a comparison sampler filter', () => {
        const r = resolveSampler(base, { isDepth: true, compare: true, maxAnisotropy: 16 });
        expect(r.minFilter).toBe('linear');
        expect(r.magFilter).toBe('linear');
        expect(r.compare).toBe(true);
    });

    it('drops authored LOD clamps on a depth texture', () => {
        const withLod = { ...base, lodMinClamp: 2, lodMaxClamp: 5 };
        expect(resolveSampler(withLod, colour).lodMinClamp).toBe(2);
        expect(resolveSampler(withLod, { ...colour, isDepth: true }).lodMinClamp).toBeUndefined();
        expect(resolveSampler(withLod, { ...colour, isDepth: true }).lodMaxClamp).toBeUndefined();
    });
});

describe('resolveSampler — passthrough', () => {
    it('keeps the three address modes independent', () => {
        const r = resolveSampler(
            { ...base, addressModeU: 'repeat', addressModeV: 'mirror-repeat', addressModeW: 'clamp-to-edge' },
            colour);
        expect([r.addressModeU, r.addressModeV, r.addressModeW])
            .toEqual(['repeat', 'mirror-repeat', 'clamp-to-edge']);
    });

    it('falls back to the documented default for a texture that was never configured', () => {
        expect(resolveSampler(null, colour)).toEqual({ ...DEFAULT_RESOLVED_SAMPLER, compare: false });
    });
});

describe('samplerKey', () => {
    // The regression this key exists for: the old one collapsed 'linear' and 'linear-mipmap-linear'
    // to the same string while the sampler built from it read the uncollapsed value, so a mipped and
    // an unmipped texture shared one cache entry and the second inherited the first one's mip filter.
    it('separates a mipped texture from an unmipped one', () => {
        const mipped = resolveSampler(base, colour);
        const flat = resolveSampler({ ...base, mipmapFilter: null }, colour);
        expect(samplerKey(mipped)).not.toBe(samplerKey(flat));
    });

    it('gives every distinguishing field its own place in the key', () => {
        const variants: TextureConfigureDescriptor[] = [
            base,
            { ...base, addressModeU: 'clamp-to-edge' },
            { ...base, addressModeV: 'clamp-to-edge' },
            { ...base, addressModeW: 'repeat' },
            { ...base, minFilter: 'nearest' },
            { ...base, magFilter: 'nearest' },
            { ...base, mipmapFilter: 'nearest' },
            { ...base, mipmapFilter: null },
            { ...base, maxAnisotropy: 8 },
            { ...base, lodMinClamp: 1 },
            { ...base, lodMaxClamp: 4 },
        ];
        const keys = variants.map(v => samplerKey(resolveSampler(v, colour)));
        expect(new Set(keys).size).toBe(variants.length);
    });

    it('gives two equivalent samplers the same key, so the cache still hits', () => {
        expect(samplerKey(resolveSampler(base, colour)))
            .toBe(samplerKey(resolveSampler({ ...base }, colour)));
        // Different requests, one resolved sampler: both are forced back to 1x.
        expect(samplerKey(resolveSampler({ ...base, magFilter: 'nearest', maxAnisotropy: 4 }, colour)))
            .toBe(samplerKey(resolveSampler({ ...base, magFilter: 'nearest', maxAnisotropy: 16 }, colour)));
    });

    it('separates a comparison sampler from an ordinary one', () => {
        const plain = resolveSampler(base, { ...colour, isDepth: true, compare: false });
        const shadow = resolveSampler(base, { ...colour, isDepth: true, compare: true });
        expect(samplerKey(plain)).not.toBe(samplerKey(shadow));
    });
});

// The WebGL2 half: a resolved sampler has to survive the fold into GL's fused min-filter enum.
describe('resolved sampler through the WebGL2 enums', () => {
    it('folds the min/mip pair into the four mipmap enums', () => {
        expect(glMinFilter('linear', 'linear')).toBe(GL_ENUMS.LINEAR_MIPMAP_LINEAR);
        expect(glMinFilter('linear', 'nearest')).toBe(GL_ENUMS.LINEAR_MIPMAP_NEAREST);
        expect(glMinFilter('nearest', 'linear')).toBe(GL_ENUMS.NEAREST_MIPMAP_LINEAR);
        expect(glMinFilter('nearest', 'nearest')).toBe(GL_ENUMS.NEAREST_MIPMAP_NEAREST);
    });

    // Nearest minification WITH a mip chain had no spelling in the old fused union, so it collapsed
    // to plain NEAREST and the chain went unread.
    it('reaches NEAREST_MIPMAP_LINEAR, which the old fused filter could not name', () => {
        const r = resolveSampler({ ...base, minFilter: 'nearest', mipmapFilter: 'linear' }, colour);
        expect(glMinFilter(r.minFilter, r.mipmapFilter)).toBe(GL_ENUMS.NEAREST_MIPMAP_LINEAR);
    });

    it('collapses to the plain filter when there is no chain', () => {
        const r = resolveSampler({ ...base, mipmapFilter: null }, colour);
        expect(glMinFilter(r.minFilter, r.mipmapFilter)).toBe(GL_ENUMS.LINEAR);
    });

    // Magnification was hardcoded to LINEAR, which is why pixel art has never been sharp magnified.
    it('carries a nearest magnification filter through', () => {
        const r = resolveSampler({ ...base, magFilter: 'nearest' }, colour);
        expect(glMagFilter(r.magFilter)).toBe(GL_ENUMS.NEAREST);
        expect(glMagFilter(resolveSampler(base, colour).magFilter)).toBe(GL_ENUMS.LINEAR);
    });

    it('maps each address mode to its own wrap enum', () => {
        const r = resolveSampler(base, colour);
        expect(glAddressMode(r.addressModeU)).toBe(GL_ENUMS.REPEAT);
        expect(glAddressMode(r.addressModeW)).toBe(GL_ENUMS.CLAMP_TO_EDGE);
        expect(glAddressMode('mirror-repeat')).toBe(GL_ENUMS.MIRRORED_REPEAT);
    });
});
