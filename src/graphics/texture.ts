import { GLState } from "./systems/glState";
import { bytesToDataUrl } from "../core/base64";
import { Logger } from "../core/logger";
import { resolveTextureFormat } from "./rhi/textureFormat";
import { glTextureFormat, glTextureTarget, glAddressMode, glMinFilter } from "./rhi/webgl2/glEnums";
import { device } from "./rhi/deviceHandle";
import type { TextureView as RhiTextureView } from './rhi/resources';
import type { CommandEncoder } from './rhi/device';
import { WebGL2Texture } from "./rhi/webgl2/webgl2Device";
import type { Texture as RhiTexture } from "./rhi/resources";
import { WebGL2TextureView } from "./rhi/webgl2/webgl2Commands";
import { TextureUsage } from "./rhi/types";
import type { TextureFormat, TextureDimension, AddressMode } from "./rhi/types";

// Float-texture capability, as the device reported it at boot.
function floatSupport(): { floatRenderable: boolean; floatFilterable: boolean } {
    const caps = device.capabilities;
    return { floatRenderable: caps.floatRenderable, floatFilterable: caps.floatFilterable };
}

// Warn once per FORMAT, not per texture: a device without the float extensions downgrades dozens.
const reportedDowngrades = new Set<string>();
function reportFloatDowngrade(requested: TextureFormat, actual: TextureFormat): void {
    if (reportedDowngrades.has(requested)) return;
    reportedDowngrades.add(requested);
    Logger.warn(
        `Float textures are unavailable on this device: ${requested} allocated as ${actual}. ` +
        `HDR rendering (bloom threshold, tonemapping headroom) will be clipped to 0..1.`,
        'Runtime',
    );
}

export interface TextureConfig {
    flipY?: boolean;
    usage?: 'color' | 'depth';
    wrapping?: 'clamp' | 'repeat' | 'mirror';
    mipMap?: boolean;
    mipMapFilter?: 'nearest' | 'linear';
    precision?: 'low' | 'high';
    target?: 'texture2D' | 'cubemap' | 'texture3D' | 'texture2DArray';
    /** Colour channels. Defaults to RGBA; 'r' is a single-channel target for scalar buffers. */
    channels?: 'rgba' | 'r';
    /**
     * An exact format, bypassing the `precision`/`channels` inference. Still subject to the float
     * fallback in rhi/textureFormat.ts.
     */
    format?: TextureFormat;
    /**
     * Dimensions to allocate at creation rather than on first upload. Needed only by textures that
     * are never uploaded to — the cloud-noise volume, filled by a compute dispatch on WebGPU.
     */
    size?: { width: number; height: number; depth?: number };
    /**
     * Allocate so a compute shader can write this (`texture_storage_*`). Exclusive with render-
     * attachment usage, requires {@link size}, and is ignored on WebGL2.
     */
    storage?: boolean;
}

/** The six images of a cubemap, in GL face order. Every face is required. */
export interface CubemapFaces {
    posX: HTMLImageElement,
    negX: HTMLImageElement,
    posY: HTMLImageElement,
    negY: HTMLImageElement,
    posZ: HTMLImageElement,
    negZ: HTMLImageElement
}

/** TextureConfig's short wrapping names mapped onto the RHI's. */
const ADDRESS_MODES: Readonly<Record<'clamp' | 'repeat' | 'mirror', AddressMode>> = {
    clamp: 'clamp-to-edge', repeat: 'repeat', mirror: 'mirror-repeat',
};

export class Texture {
    // The device-owned texture, typed by the RHI interface. `bind`/`unbind` are the only WebGL2-only
    // operations, and they cast at their call sites.
    private readonly _gpu: RhiTexture;
    private _width: number = 0;
    private _height: number = 0;
    // Colour channels actually allocated (1 for an R8/R16F target, 4 otherwise). Only affects byteSize.
    private _channels: number = 4;
    // Third dimension: slices of a TEXTURE_3D volume, or layers of a TEXTURE_2D_ARRAY.
    private _depth: number = 0;
    private _data: HTMLImageElement | CubemapFaces | null = null;
    // The compressed bytes this texture was decoded from, kept so it can be serialized without
    // re-encoding through a canvas. Base64 is produced (and memoized) only when an asset is saved.
    private _source: { bytes: Uint8Array; mime: string } | null = null;
    private _sourceUri: string | null = null; // memoized data URL for _source
    private _objectUrl: string | null = null; // blob: URL backing _data's src; revoked on delete()
    private _flipY: boolean;
    private _usage: 'color' | 'depth';
    private _precision: 'low' | 'high';
    private _wrapping: number;
    private _addressMode: AddressMode;
    private _mipMapFilter: 'nearest' | 'linear' = 'linear';
    private _target: number;
    private _internalFormat: number;
    private _mipMap: boolean;
    private _minFilter: number;
    private _format: number;
    private _type: number;
    // Unit this texture was last bound to, so `unbind()` releases that unit rather than assuming 0.
    private _boundSlot: number = 0;
    // Definite-assignment: written by the constructor, immediately below.
    private _resolvedFormat!: TextureFormat;

    constructor(options?: TextureConfig) {
        this._flipY = options?.flipY || false;
        this._usage = options?.usage || 'color';
        this._precision = options?.precision || 'low';
        this._mipMap = options?.mipMap === undefined ? true : options.mipMap;

        const dimension: TextureDimension = options?.target === 'cubemap' ? 'cube'
                     : options?.target === 'texture3D' ? '3d'
                     : options?.target === 'texture2DArray' ? '2d-array'
                     : '2d';
        this._target = glTextureTarget(dimension);

        this._addressMode = ADDRESS_MODES[options?.wrapping ?? 'clamp'];
        this._wrapping = glAddressMode(this._addressMode);

        // Format policy, including the float-to-RGBA8 fallback, lives in rhi/textureFormat.ts.
        const resolved = resolveTextureFormat(
            { usage: this._usage, precision: this._precision, channels: options?.channels, format: options?.format },
            floatSupport(),
        );
        this._resolvedFormat = resolved.format;
        if (resolved.downgraded) reportFloatDowngrade(resolved.requested, resolved.format);

        // Dimensions up front when the caller named them — see TextureConfig.size.
        const size = options?.size;
        if (size) {
            this._width = size.width;
            this._height = size.height;
            this._depth = size.depth ?? 0;
        }
        this._gpu = device.createTexture({
            label: 'texture',
            format: resolved.format,
            dimension,
            width: size?.width ?? 0, height: size?.height ?? 0,
            ...(size?.depth !== undefined ? { depthOrArrayLayers: size.depth } : {}),
            usage: this._usage === 'depth'
                ? TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING
                  | TextureUsage.COPY_SRC | TextureUsage.COPY_DST   // _copyDepth blits between targets
                // STORAGE_BINDING replaces attachment usage rather than joining it — asking for both
                // narrows the formats WebGPU accepts.
                : options?.storage
                    ? TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST | TextureUsage.STORAGE_BINDING
                    // COPY_SRC too: a colour target can be read back (thumbnails, probe preview,
                    // depth blit), and WebGPU's `copyTextureToBuffer` refuses without it.
                    : TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST
                      | TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
        });

        const triple = glTextureFormat(resolved.format);
        this._internalFormat = triple.internalFormat;
        this._format = triple.format;
        this._type = triple.type;
        this._channels = this._usage === 'depth' ? 1 : (options?.channels === 'r' ? 1 : 4);

        const filter = options?.mipMapFilter === 'nearest' ? 'nearest' : 'linear';
        this._mipMapFilter = filter;
        this._minFilter = glMinFilter(filter, this._mipMap ? filter : null);

        this._gpu.configure({
            format: resolved.format,
            addressMode: this._addressMode,
            minFilter: this._mipMap ? (filter === 'nearest' ? 'nearest' : 'linear-mipmap-linear')
                                    : filter,
            flipY: this._flipY,
            isDepth: this._usage === 'depth',
        });
    }

    /** The format actually allocated, which is not necessarily the one requested. */
    public get format(): TextureFormat { return this._resolvedFormat; }

    /** The device-owned handle. Everything below still binds and uploads through it directly. */
    private get _texture(): WebGLTexture { return (this._gpu as WebGL2Texture).handle; }

    /** Bind for sampling at a texture UNIT. WebGL2 only — WebGPU binds through bind groups. */
    public bind(slot: number = 0): void {
        if (device.backend !== 'webgl2') return;
        (this._gpu as WebGL2Texture).bind(slot);
    }

    /** Release whichever unit this texture was last bound to. A no-op off WebGL2. */
    public unbind(): void {
        if (device.backend !== 'webgl2') return;
        (this._gpu as WebGL2Texture).unbind();
    }

    /** Close an upload: record the dimensions it established, then release the upload unit. */
    private _finishUpload(): void {
        this._syncGpuSize();
        this.unbind();
    }

    public create(data: HTMLImageElement | CubemapFaces | null, width: number = 0, height: number = 0): void {
        this._data = data;
        this._width = width;
        this._height = height;
        this._syncGpuSize();   // allocate before uploading - see _syncGpuSize

        if (this._gpu.dimension === '2d') {
            const img = data as HTMLImageElement | null;
            if (img) {
                Logger.print('info', ['Creating texture with image:', {
                    width: img.width,
                    height: img.height,
                    complete: img.complete,
                    naturalWidth: img.naturalWidth,
                    naturalHeight: img.naturalHeight,
                    src: img.src?.substring(0, 50) + '...'
                }], 'Texture');

                if (!img.complete || img.naturalWidth === 0) {
                    Logger.error('Image not properly loaded before texture creation', 'Texture');
                    this._finishUpload();
                    return;
                }
            }
            this._gpu.upload2D(img, this._width, this._height, this._mipMap);
        } else {
            // Null data on a cubemap allocates six empty faces; a no-op would leave it incomplete.
            const faces = data as CubemapFaces | null;
            const images = faces
                ? [faces.posX, faces.negX, faces.posY, faces.negY, faces.posZ, faces.negZ]
                : null;
            this._gpu.uploadCube(images, this._width, this._height, this._mipMap);
        }

        this._finishUpload();
    }

    /**
     * Create the texture from a raw RGBA byte array (e.g. an editable splat map). No mipmaps/flip so the
     * data maps 1:1 to UVs, and it can be partially updated later with `updateRegion`.
     */
    public createFromData(data: Uint8Array, width: number, height: number, wrapping: 'clamp' | 'repeat' | 'mirror' = 'clamp'): void {
        this._data = null;
        this._width = width;
        this._height = height;
        this._syncGpuSize();   // allocate before uploading - see _syncGpuSize
        this._gpu.uploadBytes(data, width, height, ADDRESS_MODES[wrapping]);
        this._finishUpload();
    }

    /** Upload a sub-rectangle of RGBA bytes (row-major, tightly packed) into an existing data texture. */
    public updateRegion(x: number, y: number, width: number, height: number, data: Uint8Array): void {
        this._gpu.uploadRegion(x, y, width, height, data);
        this.unbind();
    }

    public updateImg(data: HTMLImageElement | null): void {
        if (this._gpu.dimension !== '2d') {
            Logger.error('Cannot update 2D texture with cubemap face', 'Texture');
            return;
        }
        this._data = data;
        if (data) {
            this._width = data.width;
            this._height = data.height;
        }
        this._gpu.upload2D(data, this._width, this._height, this._mipMap);
        this._finishUpload();
    }

    public updateFace(face: 'posX' | 'negX' | 'posY' | 'negY' | 'posZ' | 'negZ', data: HTMLImageElement): void {
        if (this._gpu.dimension !== 'cube') {
            Logger.error('Cannot set cubemap face on non-cubemap texture', 'Texture');
            return;
        }
        // Face order matches WebGL2Texture.cubeFaces(): +X, -X, +Y, -Y, +Z, -Z.
        const order: readonly ('posX' | 'negX' | 'posY' | 'negY' | 'posZ' | 'negZ')[] =
            ['posX', 'negX', 'posY', 'negY', 'posZ', 'negZ'];
        (this._data as CubemapFaces)[face] = data;
        this._width = data.width;
        this._height = data.height;
        this._gpu.uploadFace(order.indexOf(face), data, this._mipMap);
        this._finishUpload();
    }

    /**
     * Allocate an empty renderable cubemap with immutable storage, `size` per face and `levels` mips.
     * The IBL render target: render into a face/level, then sample the whole thing as a cubemap.
     */
    public createCubemapTarget(size: number, levels: number = 1): void {
        this._width = size;
        this._height = size;
        this._mipMap = levels > 1;
        this._syncGpuSize();   // allocate before uploading - see _syncGpuSize
        this._gpu.allocateCube(size, levels);
        this._finishUpload();
    }

    /**
     * Allocate an empty renderable 3D volume with immutable storage. Requires `target: 'texture3D'`.
     * Wrapping defaults to REPEAT on all three axes, WRAP_R included.
     */
    public createVolume(width: number, height: number, depth: number,
                        wrapping: 'clamp' | 'repeat' | 'mirror' = 'repeat'): void {
        if (this._gpu.dimension !== '3d') {
            Logger.error('createVolume requires a texture created with target: "texture3D"', 'Texture');
            return;
        }
        this._width = width;
        this._height = height;
        this._depth = depth;
        this._mipMap = false; // a tiling noise field wants a single level; mips would blur the tile seams
        this._syncGpuSize();   // allocate before uploading - see _syncGpuSize
        this._gpu.allocateVolume(width, height, depth, ADDRESS_MODES[wrapping]);
        this._finishUpload();
    }

    /**
     * Allocate an empty renderable DEPTH texture array with immutable storage — the cascaded-shadow-map
     * target, one layer per cascade. Requires `target: 'texture2DArray'` and `usage: 'depth'`.
     */
    public createArrayTarget(size: number, layers: number, compare: boolean = true): void {
        if (this._gpu.dimension !== '2d-array') {
            Logger.error('createArrayTarget requires a texture created with target: "texture2DArray"', 'Texture');
            return;
        }
        this._width = size;
        this._height = size;
        this._depth = layers;
        this._mipMap = false;
        this._syncGpuSize();   // allocate before uploading - see _syncGpuSize
        this._gpu.allocateDepthArray(size, layers, compare);
        this._finishUpload();
    }

    /** Toggle hardware depth comparison on a depth array/2D target. */
    public setDepthCompare(enabled: boolean): void {
        this._gpu.setCompareMode(enabled);
        this.unbind();
    }

    /**
     * (Re)generate the mip chain. Pass the encoder the level-0 work was recorded into — on WebGPU,
     * omitting it while that encoder is open builds the chain from a level nothing has written.
     */
    public generateMipmaps(encoder?: CommandEncoder): void {
        this._gpu.generateMipmaps(encoder);
        this.unbind();
    }

    public delete(): void {
        // Before the destroy: a memoised view outlives the storage it names.
        this._views = null;
        this._gpu.destroy();
        if (this._objectUrl) { URL.revokeObjectURL(this._objectUrl); this._objectUrl = null; }
    }

    public get data(): HTMLImageElement | CubemapFaces | null { return this._data; }
    public get width(): number { return this._width; }
    public get height(): number { return this._height; }

    /** Remember the compressed bytes this texture was decoded from, so it can be serialized without a canvas. */
    public setSource(bytes: Uint8Array, mime: string): void {
        this._source = { bytes, mime };
        this._sourceUri = null;
    }

    /** The compressed bytes this texture was decoded from, or null (built-ins / path-loaded images). */
    public get source(): { bytes: Uint8Array; mime: string } | null { return this._source; }

    /**
     * Hold the blob: URL the image was decoded from, revoked on delete(). It must NOT be revoked on
     * load — the editor previews texture cards straight off `texture.data.src`.
     */
    public setObjectUrl(url: string): void {
        if (this._objectUrl && this._objectUrl !== url) URL.revokeObjectURL(this._objectUrl);
        this._objectUrl = url;
    }

    /** Release the blob: URL without touching the GL texture (for drop paths that don't own its lifetime). */
    public revokeObjectUrl(): void {
        if (this._objectUrl) { URL.revokeObjectURL(this._objectUrl); this._objectUrl = null; }
    }

    /** The original bytes as a data URL, or null if not created from bytes. Encoded once, then memoized. */
    public get sourceUri(): string | null {
        if (this._sourceUri) return this._sourceUri;
        if (!this._source) return null;
        this._sourceUri = bytesToDataUrl(this._source.bytes, this._source.mime);
        return this._sourceUri;
    }
    public get texture(): WebGLTexture { return this._texture; }

    /** The device-owned texture, typed by the RHI. Prefer this over `gpu`, which casts to WebGL2. */
    public get rhiTexture(): RhiTexture { return this._gpu; }

    /**
     * This texture as a render ATTACHMENT: mip 0, layer 0. Distinct from {@link sampledView}, which
     * must span the whole texture and keep its dimension — the two are different objects on WebGPU.
     */
    public get attachmentView(): RhiTextureView {
        return this._cachedView('attachment');
    }

    /** This texture as something to SAMPLE: every mip, every layer, its own view dimension. */
    public get sampledView(): RhiTextureView {
        return this._cachedView('sampled');
    }

    // Both views, memoised until the storage underneath is replaced. Keyed on `generation`, not on
    // dimensions: `setSize` destroys and recreates the GPUTexture, invalidating every view of it.
    private _cachedView(role: 'attachment' | 'sampled'): RhiTextureView {
        const generation = this._gpu.generation;
        if (this._views && this._views.generation !== generation) this._views = null;
        if (!this._views) this._views = { generation, attachment: null, sampled: null };
        const cached = this._views[role];
        if (cached) return cached;
        const made = role === 'attachment'
            ? device.createTextureView(this._gpu)
            : device.createWholeTextureView(this._gpu);
        this._views[role] = made;
        return made;
    }
    private _views: {
        generation: number;
        attachment: RhiTextureView | null;
        sampled: RhiTextureView | null;
    } | null = null;
    public get config(): TextureConfig {
        return {
            flipY: this._flipY,
            usage: this._usage,
            wrapping: this._addressMode === 'clamp-to-edge' ? 'clamp' : this._addressMode === 'repeat' ? 'repeat' : 'mirror',
            mipMap: this._mipMap,
            mipMapFilter: this._mipMapFilter,
            precision: this._precision,
            target: this._gpu.dimension === '2d' ? 'texture2D'
                  : this._gpu.dimension === '3d' ? 'texture3D'
                  : this._gpu.dimension === '2d-array' ? 'texture2DArray' : 'cubemap'
        }
    }

    /** Slices of a 3D volume or layers of a 2D array; 0 for plain 2D and cubemap textures. */
    public get depth(): number { return this._depth; }

    /** Rough VRAM footprint in bytes: width*height*depth * bytes-per-pixel * faces * mip factor. */
    public get byteSize(): number {
        this._syncGpuSize();
        return this._gpu.byteSize;
    }

    // Push the dimensions this wrapper holds into the device texture. Must be called BEFORE every
    // upload as well as after: on WebGPU this call IS the allocation.
    private _syncGpuSize(): void {
        const slices = (this._gpu.dimension === '3d' || this._gpu.dimension === '2d-array')
            ? Math.max(1, this._depth) : 1;
        // Levels of a full chain over the larger dimension, which is what generateMipmap produces.
        const levels = this._mipMap
            ? Math.floor(Math.log2(Math.max(1, this._width, this._height))) + 1
            : 1;
        this._gpu.setSize(this._width, this._height, slices, levels);
    }
}
