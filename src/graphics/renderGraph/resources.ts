// What a render-graph resource IS: a name and a shape, with no storage behind it. Which framebuffer
// backs one is decided at compile time, and two resources whose lifetimes do not overlap may well be
// handed the same one.
//
// Pure data plus one resolver: imports nothing but types and touches no device. That is what lets the
// scheduler and its aliasing be tested on Node with no GL context — see `tests/renderGraphAliasing`.

import type { TextureFormat } from '../rhi/types';

/**
 * How a resource's dimensions follow the frame's.
 *
 * The rounding is part of the contract, not an implementation detail. Each arm reproduces what the
 * hand-written allocation in `Renderer._resizeBuffers` already does, and a resource that rounded the
 * other way would sample its source on a subtly wrong grid — the bug the comment above the blur
 * targets there records. `'scaled'` FLOORS (the bloom pyramid and the half-res blur buffers);
 * `'divided'` CEILS (the motion-blur tile grid, which must cover every pixel).
 */
export type SizeClass =
    /** Full render resolution — `_renderWidth` x `_renderHeight`, never the canvas size. */
    | { readonly kind: 'render' }
    /** A fraction of it, floored. 0.5 is half res. */
    | { readonly kind: 'scaled'; readonly scale: number }
    /** One texel per KxK block of it, ceiled so the grid covers the whole image. */
    | { readonly kind: 'divided'; readonly divisor: number }
    /** Independent of the frame: the 1x1 exposure target, a baked LUT. */
    | { readonly kind: 'fixed'; readonly width: number; readonly height: number };

/**
 * Who owns a resource's storage, and whether it may be aliased.
 *
 * - `transient` lives inside one frame and is the only kind that aliases.
 * - `persistent` survives the frame and is NEVER aliased. A temporal history whose storage was lent
 *   to another pass is not stale, it is uninitialized — the distinction `Renderer._resizeBuffers`
 *   already draws when it follows a reallocation with `invalidateTemporalHistory()`.
 * - `imported` is storage the graph did not allocate and does not size: the scene buffer, the swap
 *   chain, the offscreen thumbnail target. The graph tracks the ORDER it is touched in and nothing else.
 */
export type ResourceLifetime = 'transient' | 'persistent' | 'imported';

export interface ResourceDesc {
    /** Stable across frames. It is the pool's key for a `persistent`, and a debug label otherwise. */
    readonly name: string;
    readonly size: SizeClass;
    readonly format: TextureFormat;
    /** 1 for an ordinary colour target. Attachments beyond the first are the G-buffer's. */
    readonly colorAttachments: number;
    readonly depth: boolean;
    readonly lifetime: ResourceLifetime;
}

export interface Extent { readonly width: number; readonly height: number; }

/**
 * A resource's real pixel dimensions this frame. Never returns 0 in either axis: the viewport can be
 * mid-relayout when a panel is docked, and allocating against a 0-sized canvas produces an incomplete
 * framebuffer and a console error for the frame or two before the resize lands.
 */
export function resolveExtent(size: SizeClass, renderWidth: number, renderHeight: number): Extent {
    switch (size.kind) {
        case 'render':
            return { width: Math.max(1, renderWidth), height: Math.max(1, renderHeight) };
        case 'scaled':
            return {
                width: Math.max(1, Math.floor(renderWidth * size.scale)),
                height: Math.max(1, Math.floor(renderHeight * size.scale)),
            };
        case 'divided':
            return {
                width: Math.max(1, Math.ceil(renderWidth / size.divisor)),
                height: Math.max(1, Math.ceil(renderHeight / size.divisor)),
            };
        case 'fixed':
            return { width: Math.max(1, size.width), height: Math.max(1, size.height) };
    }
}

/**
 * The storage a slot provides. Two resources may share a slot only when their descriptors produce the
 * same key, which is what keeps aliasing safe for the two caches that read a target's shape back out:
 * `Renderer._pipelineFor` keys its pipeline cache on the attachment FORMATS, and a pipeline built for
 * one format handed a target of another is a validation error on WebGPU and a silent mis-render on
 * WebGL2.
 */
export interface SlotDesc {
    readonly format: TextureFormat;
    readonly colorAttachments: number;
    readonly depth: boolean;
    readonly extent: Extent;
}

/** The aliasing bucket a resource falls in. Equal keys mean interchangeable storage. */
export function slotKey(desc: SlotDesc): string {
    return `${desc.format}|${desc.colorAttachments}|${desc.depth ? 'd' : '-'}|` +
           `${desc.extent.width}x${desc.extent.height}`;
}
