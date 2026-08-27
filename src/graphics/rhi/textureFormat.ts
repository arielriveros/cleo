// Choosing a texture format from what the caller asked for and what the device can do. A device
// without the float extensions silently turns the whole HDR pipeline LDR, so the fallback is reported.

import type { TextureFormat } from './types';

/** What the caller asked for, in `TextureConfig`'s vocabulary. */
export interface TextureFormatRequest {
    usage?: 'color' | 'depth';
    precision?: 'low' | 'high';
    channels?: 'rgba' | 'r';
    /** An exact format, bypassing the precision/channels inference. Still subject to the float fallback. */
    format?: TextureFormat;
}

/** The device's float-texture capabilities, from {@link DeviceCapabilities}. */
export interface TextureFormatSupport {
    floatRenderable: boolean;
    floatFilterable: boolean;
}

/** The outcome of {@link resolveTextureFormat}. */
export interface ResolvedTextureFormat {
    /** The format to allocate. */
    format: TextureFormat;
    /** What was asked for, which differs from `format` only when the device forced a fallback. */
    requested: TextureFormat;
    /** True when a float format was requested and the device could not supply one. */
    downgraded: boolean;
}

// Both capabilities, not either: the engine's float targets are all rendered into AND sampled bilinearly.
function floatUsable(support: TextureFormatSupport): boolean {
    return support.floatRenderable && support.floatFilterable;
}

/** The non-float format a float one falls back to. */
const FLOAT_FALLBACK: Partial<Record<TextureFormat, TextureFormat>> = {
    'r16float': 'r8unorm',
    'rgba16float': 'rgba8unorm',
    'rgba32float': 'rgba8unorm',
};

/** The format to allocate for `request` on a device with `support`, and whether it was downgraded. */
export function resolveTextureFormat(
    request: TextureFormatRequest, support: TextureFormatSupport,
): ResolvedTextureFormat {
    // Depth ignores precision and channels, and has no fallback to make.
    if (request.usage === 'depth')
        return { format: 'depth24plus', requested: 'depth24plus', downgraded: false };

    const requested: TextureFormat = request.format ?? inferFormat(request);
    const fallback = FLOAT_FALLBACK[requested];
    if (fallback && !floatUsable(support))
        return { format: fallback, requested, downgraded: true };

    return { format: requested, requested, downgraded: false };
}

// The precision/channels inference, for callers that did not name a format outright.
function inferFormat(request: TextureFormatRequest): TextureFormat {
    const single = request.channels === 'r';
    const high = request.precision === 'high';
    if (single) return high ? 'r16float' : 'r8unorm';
    return high ? 'rgba16float' : 'rgba8unorm';
}
