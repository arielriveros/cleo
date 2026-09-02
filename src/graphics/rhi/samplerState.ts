// Resolving a texture's configure state into the sampler it is sampled through.
//
// Pure, and shared by both backends on purpose. The rules below are not WebGPU trivia — they decide
// what a texture LOOKS like, and a backend that applied them differently would make the same asset
// render differently depending on which device the browser gave us.

import type { AddressMode, FilterMode, TextureConfigureDescriptor } from './types';

/**
 * A sampler with every field settled. No optionals: {@link samplerKey} builds a cache key by walking
 * this, and an optional field is a field that can be silently left out of the key.
 */
export interface ResolvedSampler {
    readonly addressModeU: AddressMode;
    readonly addressModeV: AddressMode;
    readonly addressModeW: AddressMode;
    readonly minFilter: FilterMode;
    readonly magFilter: FilterMode;
    /** null means this texture has no mip chain to filter between. */
    readonly mipmapFilter: FilterMode | null;
    readonly maxAnisotropy: number;
    readonly lodMinClamp: number | undefined;
    readonly lodMaxClamp: number | undefined;
    /** A comparison sampler — `sampler2DArrayShadow` / `sampler_comparison`. */
    readonly compare: boolean;
}

/** What a texture is sampled with when it was never configured. */
export const DEFAULT_RESOLVED_SAMPLER: ResolvedSampler = {
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge',
    minFilter: 'linear', magFilter: 'linear', mipmapFilter: null,
    maxAnisotropy: 1, lodMinClamp: undefined, lodMaxClamp: undefined, compare: false,
};

/**
 * Settle the sampler a configured texture is read through.
 *
 * Three rules are enforced here rather than trusted from the descriptor, because the descriptor is
 * ultimately authored by a user in the texture editor and two of the three are device-fatal:
 *
 *  1. A depth texture sampled WITHOUT comparison must take a non-filtering sampler — WebGPU refuses
 *     the bind group otherwise. With comparison it filters, which is the whole point of PCF.
 *  2. Anisotropy above 1 requires all three filters to be linear. WebGPU rejects the sampler outright,
 *     and a rejected sampler takes down the bind group that names it; WebGL2 would quietly ignore it,
 *     so honouring the rule on both backends is also what keeps them agreeing.
 *  3. Anisotropy is clamped to what the device reported and rounded — it is an integer count of taps.
 */
export function resolveSampler(
    config: TextureConfigureDescriptor | null | undefined,
    opts: { readonly isDepth: boolean; readonly compare: boolean; readonly maxAnisotropy: number },
): ResolvedSampler {
    const { isDepth, compare, maxAnisotropy: deviceMax } = opts;
    if (!config)
        return { ...DEFAULT_RESOLVED_SAMPLER, compare };

    // Rule 1.
    const unfilterable = isDepth && !compare;
    const minFilter: FilterMode = unfilterable ? 'nearest' : config.minFilter;
    const magFilter: FilterMode = unfilterable ? 'nearest' : config.magFilter;
    const mipmapFilter: FilterMode | null = isDepth ? null : config.mipmapFilter;

    // Rules 2 and 3.
    const trilinear = minFilter === 'linear' && magFilter === 'linear' && mipmapFilter === 'linear';
    const maxAnisotropy = trilinear
        ? Math.max(1, Math.min(Math.round(config.maxAnisotropy), Math.floor(deviceMax)))
        : 1;

    return {
        addressModeU: config.addressModeU,
        addressModeV: config.addressModeV,
        addressModeW: config.addressModeW,
        minFilter, magFilter, mipmapFilter, maxAnisotropy,
        // A depth texture's LOD range is the shadow map's own business, not an authored setting.
        lodMinClamp: isDepth ? undefined : config.lodMinClamp,
        lodMaxClamp: isDepth ? undefined : config.lodMaxClamp,
        compare,
    };
}

/**
 * A cache key covering EVERY field that distinguishes two samplers.
 *
 * The key this replaced was `${addressMode}|${filter}|${compare}`, where `filter` collapsed 'linear'
 * and 'linear-mipmap-linear' to the same string while the sampler built from it set `mipmapFilter`
 * from the uncollapsed value. A mipped and an unmipped linear texture at the same address mode
 * therefore shared one cache entry, and the second one silently inherited the first one's mip
 * behaviour — so whether a texture filtered trilinearly depended on which one was bound first.
 */
export function samplerKey(s: ResolvedSampler): string {
    return `${s.addressModeU}|${s.addressModeV}|${s.addressModeW}` +
           `|${s.minFilter}|${s.magFilter}|${s.mipmapFilter ?? '-'}` +
           `|${s.maxAnisotropy}|${s.lodMinClamp ?? '-'}|${s.lodMaxClamp ?? '-'}|${s.compare}`;
}
