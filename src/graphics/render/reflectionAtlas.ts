import { device } from '../rhi/deviceHandle';
import type { RenderTarget } from '../rhi/resources';
import { Texture } from '../texture';

/**
 * Every light probe's REFLECTION in one texture: a 2D array, one layer per probe, each layer the probe's
 * GGX-prefiltered environment in an octahedral layout, its mips the roughness levels. One texture is what
 * lets the deferred pass pick reflections PER PIXEL with a dynamic layer index, the way it picks the
 * probes' lighting, where two cube samplers handed out by the camera's position could not: GLSL ES 3.00
 * cannot index samplers dynamically and WebGL2 has no cube map arrays.
 *
 * THE BORDER. Each mip keeps a border of `REFLECTION_BORDER` of its own size on every side (16 texels at
 * 256, 1 at 16), filled with the directions just across the octahedron's folds. A constant FRACTION keeps
 * the uv -> direction mapping identical at every mip, so one hardware trilinear fetch at a fractional
 * level is seamless across the folds as well as between levels.
 */

/** Side of a layer at mip 0. 256 octahedral texels hold about what the 128-texel prefiltered cube did. */
export const REFLECTION_ATLAS_SIZE = 256;
/** Roughness levels: mip m is roughness m / (REFLECTION_MIPS - 1). Must match MAX_REFLECTION_LOD + 1. */
export const REFLECTION_MIPS = 5;
/** Border as a fraction of each mip's side. 1/16 is one texel at the coarsest level used (16 px). */
export const REFLECTION_BORDER = 1 / 16;
/** Reflecting probes the deferred pass loops over per frame. Must match MAX_REFLECTION_PROBES in deferredLighting.wgsl. */
export const MAX_REFLECTION_PROBES = 16;

type Vec3 = [number, number, number];

/** Unit direction -> [-1, 1]^2, the octahedral encoding of chunks/octNormal.wgsl `octEncode`. */
export function octEncodeDir(d: ArrayLike<number>): [number, number] {
    const l1 = Math.max(Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]), 1e-6);
    let x = d[0] / l1, y = d[1] / l1;
    if (d[2] < 0) {
        const wx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
        const wy = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
        x = wx; y = wy;
    }
    return [x, y];
}

/** [-1, 1]^2 -> unit direction, chunks/octNormal.wgsl `octDecode`. */
export function octDecodeDir(e: ArrayLike<number>): Vec3 {
    let x = e[0], y = e[1];
    const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) {
        const wx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
        const wy = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
        x = wx; y = wy;
    }
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
}

/**
 * Fold a point of the octahedral square's neighbourhood back inside it. The square's edges are mirrors:
 * (1, y) and (1, -y) are one direction, as are (x, 1) and (-x, 1), so a point just past an edge is the
 * point just inside it on the other side of the axis. What a border texel holds.
 */
export function octWrapOutside(p: [number, number]): [number, number] {
    let x = p[0], y = p[1];
    if (x > 1) { x = 2 - x; y = -y; } else if (x < -1) { x = -2 - x; y = -y; }
    if (y > 1) { y = 2 - y; x = -x; } else if (y < -1) { y = -2 - y; x = -x; }
    return [x, y];
}

/** The atlas uv (0..1, any layer and mip) a direction is sampled at: deferredLighting.wgsl `reflectionAtlasUv`. */
export function octAtlasUv(d: ArrayLike<number>): [number, number] {
    const e = octEncodeDir(d);
    const s = 1 - 2 * REFLECTION_BORDER;
    return [REFLECTION_BORDER + (e[0] * 0.5 + 0.5) * s, REFLECTION_BORDER + (e[1] * 0.5 + 0.5) * s];
}

/** The direction a texel at atlas uv holds, borders included: prefilterOct.wgsl `atlasDirection`. */
export function octAtlasDir(uv: ArrayLike<number>): Vec3 {
    const s = 1 - 2 * REFLECTION_BORDER;
    const p: [number, number] = [((uv[0] - REFLECTION_BORDER) / s) * 2 - 1, ((uv[1] - REFLECTION_BORDER) / s) * 2 - 1];
    return octDecodeDir(octWrapOutside(p));
}

/**
 * Which atlas layers are taken. A probe re-filters into a FREE layer and only gives up its old one once
 * the new is complete, so its reflection never shows a half-filtered layer: one spare layer, not a second
 * copy of every probe.
 */
export class ReflectionLayerAllocator {
    private _free: number[] = [];
    private _capacity = 0;

    constructor(capacity = 0) { this.grow(capacity); }

    public get capacity(): number { return this._capacity; }
    public get freeCount(): number { return this._free.length; }

    /** A free layer, lowest first, or -1 when every layer is taken. */
    public acquire(): number {
        if (this._free.length === 0) return -1;
        let best = 0;
        for (let i = 1; i < this._free.length; i++) if (this._free[i] < this._free[best]) best = i;
        return this._free.splice(best, 1)[0];
    }

    public release(layer: number): void {
        if (layer < 0 || layer >= this._capacity || this._free.includes(layer)) return;
        this._free.push(layer);
    }

    /** Make the allocator `capacity` layers, every one free (a regrown atlas holds nothing yet). */
    public reset(capacity: number): void {
        this._capacity = Math.max(0, capacity);
        this._free = [];
        for (let i = 0; i < this._capacity; i++) this._free.push(i);
    }

    /** Add layers up to `capacity`, keeping what is taken (the CPU side of a grow). */
    public grow(capacity: number): void {
        for (let i = this._capacity; i < capacity; i++) this._free.push(i);
        this._capacity = Math.max(this._capacity, capacity);
    }
}

/** The capacity an atlas needs for `probes` reflecting probes: one each, one spare, in steps of 4. */
export function reflectionAtlasCapacity(probes: number): number {
    return Math.max(4, Math.ceil((probes + 1) / 4) * 4);
}

/**
 * The GPU half: the array texture and its (layer, mip) render targets. Recreated, empty, when it has to
 * grow; the caller re-filters every probe into the new one (`generation` says when that happened).
 */
export class ReflectionAtlas {
    public readonly layers = new ReflectionLayerAllocator();
    private _texture: Texture | null = null;
    private _generation = 0;
    private readonly _targets = new Map<number, RenderTarget>();

    /** Bumped each time the texture is (re)created: every layer handed out before it is gone. */
    public get generation(): number { return this._generation; }
    public get texture(): Texture | null { return this._texture; }

    /** Make room for `probes` reflecting probes. Returns true when the texture was recreated (all layers lost). */
    public ensureCapacity(probes: number): boolean {
        const need = reflectionAtlasCapacity(probes);
        if (this._texture && this.layers.capacity >= need) return false;
        this._texture?.delete();
        this._targets.clear();
        const tex = new Texture({ target: 'texture2DArray', precision: 'high', mipMap: true });
        tex.createColorArray(REFLECTION_ATLAS_SIZE, REFLECTION_ATLAS_SIZE, need, true);
        this._texture = tex;
        this.layers.reset(need);
        this._generation++;
        return true;
    }

    /**
     * What the lighting binds: the atlas, or before there is one a 1x1, one-layer stand-in — a bind group
     * cannot leave a slot empty, and the loop over no probes never samples it.
     */
    public bindable(): Texture {
        if (this._texture) return this._texture;
        if (!this._fallback) {
            this._fallback = new Texture({ target: 'texture2DArray', precision: 'high', mipMap: false });
            this._fallback.createColorArray(1, 1, 1, false);
        }
        return this._fallback;
    }
    private _fallback: Texture | null = null;

    /** The render target for one layer at one mip (cached: a filter writes the same few every bake). */
    public targetFor(layer: number, mip: number): RenderTarget {
        const key = layer * 64 + mip;
        let target = this._targets.get(key);
        if (!target) {
            target = device.createRenderTarget({
                label: 'reflectionAtlas',
                colorViews: [device.createTextureView(this._texture!.rhiTexture, mip, layer)],
            });
            this._targets.set(key, target);
        }
        return target;
    }

    public destroy(): void {
        this._texture?.delete();
        this._texture = null;
        this._fallback?.delete();
        this._fallback = null;
        this._targets.clear();
    }
}
