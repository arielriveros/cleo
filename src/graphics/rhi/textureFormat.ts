/**
 * Choosing a texture format from what the caller asked for and what the device can do.
 *
 * This was four nested ternaries in the `Texture` constructor, and it hid something important: when
 * float textures are unavailable, a `precision: 'high'` request does not fail — it quietly becomes
 * RGBA8. Every HDR target in the renderer (the scene buffer, all three G-buffer attachments, the six
 * bloom mips, the compose pair, the velocity chain, the cloud targets) is allocated that way, so on a
 * device without the extensions the entire pipeline turns LDR with nothing logged anywhere.
 *
 * Pulling the decision out here does not change it. It makes it a named function that returns whether
 * the downgrade happened, so a caller can say so once, and it makes the whole policy testable without
 * a GL context.
 */

import type { TextureFormat } from './types';

/** What the caller asked for, in `TextureConfig`'s vocabulary. */
export interface TextureFormatRequest {
    usage?: 'color' | 'depth';
    precision?: 'low' | 'high';
    channels?: 'rgba' | 'r';
    /**
     * An exact format, bypassing the precision/channels inference.
     *
     * Still subject to the float fallback below — asking for `rgba16float` by name on a device that
     * cannot provide it has to degrade the same way asking for `precision: 'high'` does, or the
     * explicit path would be the one that crashes.
     */
    format?: TextureFormat;
}

/** The device's float-texture capabilities, from {@link DeviceCapabilities}. */
export interface TextureFormatSupport {
    floatRenderable: boolean;
    floatFilterable: boolean;
}

export interface ResolvedTextureFormat {
    /** The format to allocate. */
    format: TextureFormat;
    /** What was asked for, which differs from `format` only when the device forced a fallback. */
    requested: TextureFormat;
    /** True when a float format was requested and the device could not supply one. */
    downgraded: boolean;
}

/**
 * Whether float colour targets are usable at all.
 *
 * Both extensions, not either: `EXT_color_buffer_float` makes a float target renderable and
 * `OES_texture_float_linear` makes it samplable with anything but NEAREST. The engine's float targets
 * are all both rendered into and then sampled bilinearly — the bloom chain's whole job is filtered
 * downsampling — so one without the other is not enough. This reproduces the existing `&&`.
 */
function floatUsable(support: TextureFormatSupport): boolean {
    return support.floatRenderable && support.floatFilterable;
}

/** The non-float format a float one falls back to. */
const FLOAT_FALLBACK: Partial<Record<TextureFormat, TextureFormat>> = {
    'r16float': 'r8unorm',
    'rgba16float': 'rgba8unorm',
    'rgba32float': 'rgba8unorm',
};

export function resolveTextureFormat(
    request: TextureFormatRequest, support: TextureFormatSupport,
): ResolvedTextureFormat {
    // Depth ignores precision and channels entirely, and has no float fallback to make: DEPTH_COMPONENT24
    // is core WebGL2 and needs no extension.
    if (request.usage === 'depth')
        return { format: 'depth24plus', requested: 'depth24plus', downgraded: false };

    const requested: TextureFormat = request.format ?? inferFormat(request);
    const fallback = FLOAT_FALLBACK[requested];
    if (fallback && !floatUsable(support))
        return { format: fallback, requested, downgraded: true };

    return { format: requested, requested, downgraded: false };
}

/** The precision/channels inference, for callers that did not name a format outright. */
function inferFormat(request: TextureFormatRequest): TextureFormat {
    const single = request.channels === 'r';
    const high = request.precision === 'high';
    if (single) return high ? 'r16float' : 'r8unorm';
    return high ? 'rgba16float' : 'rgba8unorm';
}
