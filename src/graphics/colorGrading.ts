import { device } from './rhi/deviceHandle';
import { Texture } from './texture';
import { TextureManager } from './systems/textureManager';
import { Logger } from '../core/logger';

// -----------------------------------------------------------------------------------------------
// The colour-grading LUT, as a GPU resource: turning a texture asset into the 3D volume the present
// pass samples.
//
// The LUT is authored as a horizontal STRIP — N tiles of N x N, so width = N squared and height = N
// — which is what every grading tool exports and what an artist can open in an image editor. The
// axis convention, which is undetectable from the pixels and therefore has to be written down:
//
//     volume texel (i, j, k)  <-  strip pixel (k * N + i, j)
//
//     U (red)   = x within a tile
//     V (green) = y, measured DOWN from the TOP row of the image
//     W (blue)  = the tile index, left to right
//
// A strip authored with green running upward comes back vertically inverted and simply looks wrong,
// with nothing logged. The panel hint in the editor states the convention for that reason.
//
// The split between the pure function and the class is deliberate and is the same one `lightGrid.ts`
// makes: `stripToSlices` is where a layout mistake would live, and it is the only part testable
// without a GPU. What is left in the class cannot be tested — allocating a volume and uploading to
// it — and is correspondingly small.
// -----------------------------------------------------------------------------------------------

/**
 * Edge length of the identity volume. Two is not a compromise: with the half-texel inset the shader
 * applies (see `applyColorLut` in chunks/colorLut.wgsl), 0 and 1 land exactly on the first and last
 * texel centres, so hardware trilinear over the eight RGB corners reproduces the input EXACTLY. A
 * 16-cube identity would be 16KB and no more accurate.
 */
export const IDENTITY_LUT_SIZE = 2;

/** Largest edge length accepted. 64 is already a 4096x64 source; beyond that it is a typo. */
const MAX_LUT_SIZE = 64;

/**
 * The LUT edge length a strip of these dimensions encodes, or 0 when it is not a LUT strip at all.
 * A strip is N tiles wide and one tile tall, so `width === height * height`.
 */
export function lutSizeOf(width: number, height: number): number {
    if (height < 2 || height > MAX_LUT_SIZE) return 0;
    return width === height * height ? height : 0;
}

/**
 * Split a strip's RGBA pixels into one tightly packed N x N slice per blue level, ready to hand
 * straight to `device.writeTexture`. Returns null when the dimensions are not a LUT strip.
 *
 * Rows are consumed TOP-DOWN, which is what `CanvasRenderingContext2D.getImageData` returns and is
 * independent of `TextureConfig.flipY` — that flag only affects the GPU image-upload path, which
 * this never touches.
 */
export function stripToSlices(pixels: Uint8ClampedArray | Uint8Array,
                              width: number, height: number): Uint8Array[] | null {
    const n = lutSizeOf(width, height);
    if (n === 0 || pixels.length < width * height * 4) return null;

    const slices: Uint8Array[] = [];
    for (let z = 0; z < n; z++) {
        const slice = new Uint8Array(n * n * 4);
        for (let y = 0; y < n; y++) {
            const src = (y * width + z * n) * 4;
            slice.set(pixels.subarray(src, src + n * 4), y * n * 4);
        }
        slices.push(slice);
    }
    return slices;
}

/** What the cache remembers about the volume it last built. */
interface LutEntry {
    id: string;
    /** The exact image object the volume was built from — a re-import replaces it. */
    image: HTMLImageElement;
    width: number;
    height: number;
    volume: Texture;
    size: number;
}

export class ColorGradingLut {
    private _identity: Texture | null = null;
    private _entry: LutEntry | null = null;
    /**
     * Images that could not be read. Keyed on the IMAGE, not the id, so a bad LUT is diagnosed once
     * and retried the moment the asset is genuinely replaced — without it a malformed strip re-runs
     * a full canvas readback on every frame, forever.
     */
    private readonly _failed = new WeakSet<HTMLImageElement>();
    private _size = IDENTITY_LUT_SIZE;

    /** Edge length of whatever {@link volumeFor} last returned — the shader's `u_lutSize`. */
    public get size(): number { return this._size; }

    /**
     * The volume for `id`, or the identity volume when there is none usable. NEVER null: the present
     * pass binds this every frame whether a LUT is set or not, because WebGPU rejects a bind group
     * with an unsatisfied binding and neither the 'Null' texture nor the renderer's fallback is 3D.
     */
    public volumeFor(id: string | null | undefined): Texture {
        if (!id) return this._identityVolume();

        const image = this._imageFor(id);
        // Not decoded YET is the normal state for the first frames after a scene opens — textures
        // decode asynchronously. Fall back and try again next frame rather than caching a failure.
        if (!image) return this._identityVolume();
        if (this._failed.has(image)) return this._identityVolume();

        const entry = this._entry;
        if (entry && entry.id === id && entry.image === image
            && entry.width === image.naturalWidth && entry.height === image.naturalHeight) {
            this._size = entry.size;
            return entry.volume;
        }

        const built = this._build(id, image);
        if (!built) {
            this._failed.add(image);
            return this._identityVolume();
        }
        // Only after a successful build: a failed rebuild should not throw away a working volume.
        if (this._entry) this._entry.volume.delete();
        this._entry = built;
        this._size = built.size;
        return built.volume;
    }

    public dispose(): void {
        this._entry?.volume.delete();
        this._entry = null;
        this._identity?.delete();
        this._identity = null;
    }

    /** The decoded image behind a texture id, or null while it is still loading (or is a cubemap). */
    private _imageFor(id: string): HTMLImageElement | null {
        const data = TextureManager.Instance.getTexture(id)?.data;
        if (typeof HTMLImageElement === 'undefined' || !(data instanceof HTMLImageElement)) return null;
        return data.complete && data.naturalWidth > 0 ? data : null;
    }

    private _build(id: string, image: HTMLImageElement): LutEntry | null {
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        const n = lutSizeOf(width, height);
        if (n === 0) {
            Logger.warn(`Colour LUT "${id}" is ${width}x${height}; it must be an N-tile strip of ` +
                        `N x N tiles (256x16, 1024x32, ...)`, 'Renderer');
            return null;
        }

        const pixels = this._readPixels(id, image, width, height);
        if (!pixels) return null;
        const slices = stripToSlices(pixels, width, height);
        if (!slices) return null;

        // `size` up front AND `createVolume`: the first is what WebGPU allocates from, the second is
        // what issues `texStorage3D` on WebGL2 — without which every `texSubImage3D` below is a
        // silent no-op. `loadOnly` for the USAGE flags: the default colour set asks for
        // RENDER_ATTACHMENT, which WebGPU constrains by dimension and which a sampled-only volume
        // has no use for. It does not affect filtering; the sampler is configured separately.
        const volume = new Texture({
            target: 'texture3D', mipMap: false, loadOnly: true, wrapping: 'clamp',
            size: { width: n, height: n, depth: n },
        });
        // Clamped on all three axes. `createVolume` defaults to repeat, which would wrap black round
        // to white at the ends of every axis.
        volume.createVolume(n, n, n, 'clamp');
        for (let z = 0; z < n; z++) device.writeTexture(volume.rhiTexture, slices[z], n, n, 0, z);

        return { id, image, width, height, volume, size: n };
    }

    /** The strip's pixels, top-down RGBA, or null if the canvas will not give them up. */
    private _readPixels(id: string, image: HTMLImageElement,
                        width: number, height: number): Uint8ClampedArray | null {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { willReadFrequently: false });
            if (!ctx) return null;   // context loss or OOM
            ctx.drawImage(image, 0, 0);
            return ctx.getImageData(0, 0, width, height).data;
        } catch (err) {
            // A cross-origin image taints the canvas and `getImageData` THROWS. Everything this
            // engine loads comes from a blob: or data: URL, but `addTextureFromPath` can reach a
            // CDN, and an exception here would take down the present pass with the whole frame.
            Logger.print('warn', [`Colour LUT "${id}" could not be read:`, err], 'Renderer');
            return null;
        }
    }

    /**
     * The 2-cube identity, built once. It exists for the BIND GROUP rather than for the maths — the
     * intensity uniform is 0 whenever it is bound, so the sample is a no-op numerically too.
     */
    private _identityVolume(): Texture {
        this._size = IDENTITY_LUT_SIZE;
        if (this._identity) return this._identity;

        const n = IDENTITY_LUT_SIZE;
        const volume = new Texture({
            target: 'texture3D', mipMap: false, loadOnly: true, wrapping: 'clamp',
            size: { width: n, height: n, depth: n },
        });
        volume.createVolume(n, n, n, 'clamp');

        const slice = new Uint8Array(n * n * 4);
        for (let z = 0; z < n; z++) {
            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) {
                    const o = (y * n + x) * 4;
                    slice[o] = x * 255;
                    slice[o + 1] = y * 255;
                    slice[o + 2] = z * 255;
                    slice[o + 3] = 255;
                }
            }
            // Both backends copy on the call, so one staging buffer serves every slice.
            device.writeTexture(volume.rhiTexture, slice, n, n, 0, z);
        }

        this._identity = volume;
        return volume;
    }
}
