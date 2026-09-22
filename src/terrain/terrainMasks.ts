// A landscape's paint masks as data: one 0..1 byte channel per paint layer, packed four to an RGBA
// slice, at a resolution of its own. Pure CPU — `Terrain` owns the GPU copy and uploads the rectangles
// these operations report as dirty.
//
// Resolution is independent of the height grid on purpose. The old splat was one texel per height
// sample, 1.55 m on a default 200 m landscape, which is far too coarse for a road; a mask of its own can
// be 0.2 m without paying for 25x the vertices.
//
// TEXEL CENTRES, not vertices. Texel (c, r) covers the square whose centre is at landscape-local
// (-size/2 + (c + 0.5) * size / res, ...), which is exactly where a linearly filtered clamp-to-edge
// texture puts it when sampled at the landscape's 0..1 uv. `sample` interpolates the same way, so a
// query on the CPU reads what the shader draws.

import { brushWeight, type BrushSpec } from './sculpt';
import { MASK_CHANNELS_PER_SLICE } from './terrainLayers';

/** An inclusive rectangle of mask texels. */
export interface MaskRegion {
    c0: number; r0: number; c1: number; r1: number;
}

/** A saved rectangle of ONE channel, for undo. */
export interface MaskPatch {
    channel: number;
    region: MaskRegion;
    data: Uint8Array;
}

export interface MaskPaint {
    /** Where the brush lands, landscape-local, and its shape. */
    brush: BrushSpec;
    /** 0..1 approach toward `target` per application at full brush weight. */
    amount: number;
    /** The value painting moves toward: the layer's target opacity, or 0 to erase. */
    target: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Slices needed for `channels` mask channels. */
export function maskSlicesFor(channels: number): number {
    return Math.max(1, Math.ceil(Math.max(1, channels) / MASK_CHANNELS_PER_SLICE));
}

export class MaskGrid {
    private _res: number;
    private _size: number;
    private _slices: number;
    private _data: Uint8Array;

    /**
     * @param resolution Texels per side.
     * @param size       World size of the landscape the grid spans.
     * @param channels   Paint layers to make room for; grown later with {@link ensureChannels}.
     */
    constructor(resolution: number, size: number, channels = MASK_CHANNELS_PER_SLICE) {
        this._res = Math.max(2, Math.floor(resolution));
        this._size = size;
        this._slices = maskSlicesFor(channels);
        this._data = new Uint8Array(this._slices * this._res * this._res * 4);
    }

    public get resolution(): number { return this._res; }
    public get size(): number { return this._size; }
    public get slices(): number { return this._slices; }
    /** Channels there is room for without reallocating. */
    public get capacity(): number { return this._slices * MASK_CHANNELS_PER_SLICE; }
    /** All slices, slice-major, RGBA per texel. */
    public get data(): Uint8Array { return this._data; }

    /** An independent copy — what a brush stroke snapshots so its undo step can restore the masks. */
    public clone(): MaskGrid {
        const copy = new MaskGrid(this._res, this._size, this.capacity);
        copy._data.set(this._data);
        return copy;
    }

    /** Grow to hold `channels` channels, keeping every value. Returns true when it reallocated. */
    public ensureChannels(channels: number): boolean {
        const slices = maskSlicesFor(channels);
        if (slices <= this._slices) return false;
        const next = new Uint8Array(slices * this._res * this._res * 4);
        next.set(this._data);
        this._data = next;
        this._slices = slices;
        return true;
    }

    private _index(channel: number, c: number, r: number): number {
        const slice = Math.floor(channel / MASK_CHANNELS_PER_SLICE);
        return ((slice * this._res + r) * this._res + c) * 4 + (channel % MASK_CHANNELS_PER_SLICE);
    }

    /** One texel's value, 0..1. */
    public value(channel: number, c: number, r: number): number {
        if (channel < 0 || channel >= this.capacity) return 0;
        return this._data[this._index(channel, c, r)] / 255;
    }

    /** Landscape-local x/z of a texel centre. */
    public texelCenter(c: number, r: number): [number, number] {
        const t = this._size / this._res, half = this._size / 2;
        return [-half + (c + 0.5) * t, -half + (r + 0.5) * t];
    }

    /** Bilinear value at landscape-local x/z, clamped at the edge — what the shader samples there. */
    public sample(channel: number, x: number, z: number): number {
        if (channel < 0 || channel >= this.capacity) return 0;
        const R = this._res;
        const fx = Math.min(Math.max(((x + this._size / 2) / this._size) * R - 0.5, 0), R - 1);
        const fz = Math.min(Math.max(((z + this._size / 2) / this._size) * R - 0.5, 0), R - 1);
        const c0 = Math.floor(fx), r0 = Math.floor(fz);
        const c1 = Math.min(c0 + 1, R - 1), r1 = Math.min(r0 + 1, R - 1);
        const tx = fx - c0, tz = fz - r0;
        const a = this.value(channel, c0, r0) + (this.value(channel, c1, r0) - this.value(channel, c0, r0)) * tx;
        const b = this.value(channel, c0, r1) + (this.value(channel, c1, r1) - this.value(channel, c0, r1)) * tx;
        return a + (b - a) * tz;
    }

    /** The texel rectangle a world-space box covers, clipped; null when it misses. */
    public regionFor(minX: number, minZ: number, maxX: number, maxZ: number): MaskRegion | null {
        const R = this._res, t = this._size / R, half = this._size / 2;
        const c0 = Math.max(0, Math.floor((minX + half) / t - 0.5));
        const c1 = Math.min(R - 1, Math.ceil((maxX + half) / t - 0.5));
        const r0 = Math.max(0, Math.floor((minZ + half) / t - 0.5));
        const r1 = Math.min(R - 1, Math.ceil((maxZ + half) / t - 0.5));
        return c0 > c1 || r0 > r1 ? null : { c0, r0, c1, r1 };
    }

    /**
     * Move one channel toward `target` under a brush. Returns the rectangle that changed, or null.
     * Painting never touches another channel: layers are composited, not normalised.
     */
    public paint(channel: number, p: MaskPaint): MaskRegion | null {
        if (channel < 0 || channel >= this.capacity) return null;
        const b = p.brush;
        const reach = b.shape === 'square' || b.stamp ? b.radius * Math.SQRT2 : b.radius;
        const reg = this.regionFor(b.x - reach, b.z - reach, b.x + reach, b.z + reach);
        if (!reg) return null;
        const k = clamp01(Math.abs(p.amount));
        // A whole byte, or the half-away rounding below would oscillate across a .5 target forever.
        const target = Math.round(clamp01(p.target) * 255);
        let changed: MaskRegion | null = null;
        for (let r = reg.r0; r <= reg.r1; r++) {
            for (let c = reg.c0; c <= reg.c1; c++) {
                const [x, z] = this.texelCenter(c, r);
                const w = brushWeight(x - b.x, z - b.z, b);
                if (w <= 0) continue;
                const i = this._index(channel, c, r);
                const v = this._data[i];
                // Rounded half AWAY from zero, i.e. toward the target: Math.round sends +0.5 up and so,
                // one step short of zero, an erase at half strength lands back where it started forever.
                // Never overshoots, since the step is at most the whole remaining distance.
                const delta = (target - v) * Math.min(1, k * w);
                const next = v + Math.sign(delta) * Math.floor(Math.abs(delta) + 0.5);
                if (next === v) continue;
                this._data[i] = next;
                changed = grow(changed, c, r);
            }
        }
        return changed;
    }

    /** Set a whole channel to one value (Fill = 1, Clear = 0). Returns the full region, or null if nothing changed. */
    public fill(channel: number, value: number): MaskRegion | null {
        if (channel < 0 || channel >= this.capacity) return null;
        const v = Math.round(clamp01(value) * 255);
        let any = false;
        for (let r = 0; r < this._res; r++)
            for (let c = 0; c < this._res; c++) {
                const i = this._index(channel, c, r);
                if (this._data[i] !== v) { this._data[i] = v; any = true; }
            }
        return any ? this.fullRegion() : null;
    }

    /** Invert a whole channel. */
    public invert(channel: number): MaskRegion | null {
        if (channel < 0 || channel >= this.capacity) return null;
        for (let r = 0; r < this._res; r++)
            for (let c = 0; c < this._res; c++) {
                const i = this._index(channel, c, r);
                this._data[i] = 255 - this._data[i];
            }
        return this.fullRegion();
    }

    /** Copy channel `from` into channel `to` (a layer reorder moves masks this way). */
    public copyChannel(from: number, to: number): void {
        if (from === to || from < 0 || to < 0 || from >= this.capacity || to >= this.capacity) return;
        for (let r = 0; r < this._res; r++)
            for (let c = 0; c < this._res; c++)
                this._data[this._index(to, c, r)] = this._data[this._index(from, c, r)];
    }

    /** Whether any texel of a channel is above zero. */
    public isEmpty(channel: number): boolean {
        if (channel < 0 || channel >= this.capacity) return true;
        for (let r = 0; r < this._res; r++)
            for (let c = 0; c < this._res; c++)
                if (this._data[this._index(channel, c, r)] !== 0) return false;
        return true;
    }

    /** Fraction of texels where a channel is at least half on. */
    public coverage(channel: number): number {
        if (channel < 0 || channel >= this.capacity) return 0;
        let n = 0;
        for (let r = 0; r < this._res; r++)
            for (let c = 0; c < this._res; c++)
                if (this._data[this._index(channel, c, r)] >= 128) n++;
        return n / (this._res * this._res);
    }

    public fullRegion(): MaskRegion {
        return { c0: 0, r0: 0, c1: this._res - 1, r1: this._res - 1 };
    }

    /** Save a rectangle of one channel, for undo. */
    public readPatch(channel: number, region: MaskRegion): MaskPatch {
        const w = region.c1 - region.c0 + 1, h = region.r1 - region.r0 + 1;
        const data = new Uint8Array(w * h);
        for (let r = 0; r < h; r++)
            for (let c = 0; c < w; c++)
                data[r * w + c] = this._data[this._index(channel, region.c0 + c, region.r0 + r)];
        return { channel, region: { ...region }, data };
    }

    /** Put a saved rectangle back. */
    public writePatch(patch: MaskPatch): void {
        const { region, data, channel } = patch;
        const w = region.c1 - region.c0 + 1, h = region.r1 - region.r0 + 1;
        for (let r = 0; r < h; r++)
            for (let c = 0; c < w; c++)
                this._data[this._index(channel, region.c0 + c, region.r0 + r)] = data[r * w + c];
    }

    /**
     * One slice's RGBA bytes over a rectangle, tightly packed — what the GPU upload of a dirty region
     * sends. `out` is reused when large enough.
     */
    public sliceRect(slice: number, region: MaskRegion, out?: Uint8Array): Uint8Array {
        const w = region.c1 - region.c0 + 1, h = region.r1 - region.r0 + 1;
        const bytes = w * h * 4;
        const dst = out && out.length >= bytes ? out.subarray(0, bytes) : new Uint8Array(bytes);
        const R = this._res;
        for (let r = 0; r < h; r++) {
            const src = ((slice * R + region.r0 + r) * R + region.c0) * 4;
            dst.set(this._data.subarray(src, src + w * 4), r * w * 4);
        }
        return dst;
    }

    /** Fill every channel of this grid by resampling `other` (bilinear), stretching it over this grid's area. */
    public resampleFrom(other: MaskGrid): void {
        this.ensureChannels(other.capacity);
        for (let ch = 0; ch < other.capacity; ch++) {
            for (let r = 0; r < this._res; r++)
                for (let c = 0; c < this._res; c++) {
                    // Normalised position, so a resize stretches the painting with the landscape.
                    const u = (c + 0.5) / this._res, v = (r + 0.5) / this._res;
                    const x = (u - 0.5) * other.size, z = (v - 0.5) * other.size;
                    this._data[this._index(ch, c, r)] = Math.round(other.sample(ch, x, z) * 255);
                }
        }
    }

    /** Overwrite everything with bytes saved by {@link data} at the same resolution; false on a mismatch. */
    public load(bytes: Uint8Array, resolution: number, slices: number): boolean {
        if (resolution !== this._res) return false;
        this.ensureChannels(slices * MASK_CHANNELS_PER_SLICE);
        const n = Math.min(bytes.length, this._data.length);
        this._data.fill(0);
        this._data.set(bytes.subarray(0, n));
        return true;
    }
}

function grow(reg: MaskRegion | null, c: number, r: number): MaskRegion {
    if (!reg) return { c0: c, r0: r, c1: c, r1: r };
    if (c < reg.c0) reg.c0 = c;
    if (c > reg.c1) reg.c1 = c;
    if (r < reg.r0) reg.r0 = r;
    if (r > reg.r1) reg.r1 = r;
    return reg;
}
