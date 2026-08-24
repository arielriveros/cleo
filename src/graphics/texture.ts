import { GLState } from "./systems/glState";
import { bytesToDataUrl } from "../core/base64";
import { Logger } from "../core/logger";
import { resolveTextureFormat } from "./rhi/textureFormat";
import { glTextureFormat, glTextureTarget, glAddressMode, glMinFilter } from "./rhi/webgl2/glEnums";
import { device } from "./rhi/deviceHandle";
import { WebGL2Texture } from "./rhi/webgl2/webgl2Device";
import type { Texture as RhiTexture } from "./rhi/resources";
import { WebGL2TextureView } from "./rhi/webgl2/webgl2Commands";
import { TextureUsage } from "./rhi/types";
import type { TextureFormat, TextureDimension, AddressMode } from "./rhi/types";

/**
 * Float-texture capability, as the device reported it at boot.
 *
 * This used to be two `getExtension` calls in the `Texture` constructor — on every single texture the
 * engine ever allocated. The device resolves both once while acquiring the context and publishes them
 * through {@link DeviceCapabilities}, so this is now a field read.
 */
function floatSupport(): { floatRenderable: boolean; floatFilterable: boolean } {
    const caps = device.capabilities;
    return { floatRenderable: caps.floatRenderable, floatFilterable: caps.floatFilterable };
}

/**
 * Say, once, that a float target was downgraded.
 *
 * Once per format rather than per texture: the renderer allocates well over a dozen HDR targets, and a
 * device missing the extensions would otherwise produce a wall of identical warnings at boot. One line
 * is enough to explain why the image looks banded and clipped.
 */
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
    /**
     * Number of colour channels. Defaults to RGBA; 'r' allocates a single-channel target, for buffers
     * that hold one scalar (ambient occlusion, masks) and would otherwise pay 4x the bandwidth and
     * memory to store three copies of nothing.
     */
    channels?: 'rgba' | 'r';
    /**
     * An exact format, bypassing the `precision`/`channels` inference.
     *
     * Still subject to the same float fallback: naming `rgba16float` on a device without the float
     * extensions degrades to RGBA8 exactly as `precision: 'high'` does. See rhi/textureFormat.ts.
     */
    format?: TextureFormat;
    /**
     * Dimensions to allocate at CREATION, rather than whenever an upload gets around to it.
     *
     * Every other path here allocates lazily because that is how WebGL2 works: `texImage2D` and
     * `texStorage3D` both establish storage long after `createTexture`, so `new Texture(...)` asks
     * the device for a 0x0 and the uploads correct it. A `GPUTexture` cannot work that way — its size
     * is fixed when it is made, and the WebGPU backend's upload entry points say so by throwing.
     *
     * This is the narrow declarative escape hatch for the one texture that has to be right up front:
     * the cloud-noise volume, which on WebGPU is filled by a compute dispatch and so is never
     * "uploaded" at all. It is NOT the general fix — the rest of the engine still allocates through
     * its uploads, and reforming that is a separate piece of work.
     */
    size?: { width: number; height: number; depth?: number };
    /**
     * Allocate this texture so a compute shader can WRITE it (`texture_storage_*`).
     *
     * Exclusive with render-attachment usage rather than additive: a storage texture is never drawn
     * into, and WebGPU refuses some format/usage combinations that carry both. Requires {@link size},
     * since a storage binding needs real dimensions before anything can be dispatched against it.
     *
     * Ignored on WebGL2, which has no storage textures — `createVolume()` there still runs
     * `texStorage3D` exactly as it always did.
     */
    storage?: boolean;
}

/**
 * The six images of a cubemap, in GL face order.
 *
 * Every face is required. The `| null` these once carried was unsourced — no producer in the engine ever
 * yields a null face, because they all resolve through `Loader.loadImage`, which rejects on error rather
 * than resolving null. It only forced null checks on code that could never see one.
 */
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
    /**
     * The device-owned texture object. `_texture` below is a getter onto its handle, so the upload
     * paths — six of them, one per WebGL2 entry point — keep reading exactly as they did while the
     * allocation, the lifetime and the byte accounting move behind the RHI.
     */
    /**
     * The device-owned texture, as the RHI describes one.
     *
     * Typed by the INTERFACE rather than the WebGL2 class, which is what makes this file portable:
     * every upload below goes through methods both backends can implement, and the two that cannot
     * (`bind` to a texture unit, `unbind`) are cast at their call sites so the coupling is one named
     * exception instead of the whole class.
     */
    private readonly _gpu: RhiTexture;
    private _width: number = 0;
    private _height: number = 0;
    // Colour channels actually allocated (1 for an R8/R16F target, 4 otherwise). Only affects byteSize.
    private _channels: number = 4;
    // Third dimension: slices of a TEXTURE_3D volume or layers of a TEXTURE_2D_ARRAY. Kept as a plain field rather than
    // a separate subclass so `byteSize`, `bind`/`unbind` and `delete` stay single implementations.
    private _depth: number = 0;
    private _data: HTMLImageElement | CubemapFaces | null = null;
    // The compressed bytes this texture was decoded from (PNG/JPEG/…), kept so it can be serialized
    // without re-encoding it through a canvas. Import decodes from a Blob URL, so the image has no data:
    // URL to reuse — these bytes are what `TextureManager.serializeTexture` falls back to, and the base64
    // is only ever produced (and then memoized) when an asset is actually saved.
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

        // Which format the device can actually give us, and whether that is the one we asked for. The
        // policy — including the float-to-RGBA8 fallback that silently turns the HDR pipeline LDR — is
        // in rhi/textureFormat.ts so it can be tested without a context.
        const resolved = resolveTextureFormat(
            { usage: this._usage, precision: this._precision, channels: options?.channels, format: options?.format },
            floatSupport(),
        );
        this._resolvedFormat = resolved.format;
        if (resolved.downgraded) reportFloatDowngrade(resolved.requested, resolved.format);

        // Dimensions up front when the caller named them — see TextureConfig.size. Recorded on the
        // wrapper too, so `byteSize` and the eager `_syncGpuSize` agree with what the device holds
        // for a texture that will never travel an upload path.
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
                // STORAGE_BINDING REPLACES the attachment usage rather than joining it: nothing draws
                // into a storage texture, and asking for both narrows the formats WebGPU will accept.
                : options?.storage
                    ? TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST | TextureUsage.STORAGE_BINDING
                    : TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST | TextureUsage.RENDER_ATTACHMENT,
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

    /** Bind for sampling. See WebGL2Texture.bind — the state cache lives with the GPU resource now. */
    /**
     * Bind for sampling at a texture UNIT.
     *
     * Not on the RHI interface and never will be: a unit is a WebGL2 concept, and WebGPU binds
     * through bind groups instead. The remaining callers are the legacy material-application paths;
     * they go when those do.
     */
    public bind(slot: number = 0): void {
        if (device.backend !== 'webgl2') return;
        (this._gpu as WebGL2Texture).bind(slot);
    }

    /**
     * Release whichever unit this texture was last bound to.
     *
     * A no-op off WebGL2, and that guard is not a stub. `_finishUpload` calls this after EVERY upload,
     * so without it the first texture any backend without units allocates dies on `unbind is not a
     * function` - a legacy epilogue killing a path that had otherwise completed. There is no unit to
     * release when bind groups name their resources directly.
     */
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
            // Null data on a cubemap allocates six empty faces rather than walking into `faces.posX` —
            // `new Skybox(null)` reaches exactly here, and a no-op would leave the texture incomplete,
            // which is a subtler failure than the crash it replaced.
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
     * Allocate an empty renderable cubemap (all 6 faces) with immutable storage, sized `size` per
     * face and `levels` mip levels. Used as an IBL render target (captured environment, irradiance,
     * prefiltered specular) — render into a face/level with a framebuffer, then sample as a cubemap.
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
     *
     * Wrapping defaults to REPEAT on all three axes, including WRAP_R (which the 2D path never sets),
     * because the only consumer so far is a *tileable* noise field whose whole purpose is to repeat.
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
     * Allocate an empty renderable DEPTH texture array with immutable storage. Requires
     * `target: 'texture2DArray'` and `usage: 'depth'`. This is the cascaded-shadow-map target: one
     * layer per cascade, filled through `gl.framebufferTextureLayer` (see LayeredDepthFramebuffer).
     *
     * One array replaces N separate `sampler2D`s: GLSL ES 3.00 forbids dynamically indexing a SAMPLER
     * array, which is why the old three-cascade code unrolled its cascade select into an if-chain and
     * burned three texture units. A `sampler2DArray` takes a dynamic layer index, so the cascade count
     * becomes a plain uniform and the whole thing costs one unit.
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

    /** (Re)generate the mip chain for this texture — e.g. after rendering a captured cubemap. */
    public generateMipmaps(): void {
        this._gpu.generateMipmaps();
        this.unbind();
    }

    public delete(): void {
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
     * Hold the blob: URL the image was decoded from, alive for the texture's lifetime and revoked on
     * delete().
     *
     * It must NOT be revoked once the image loads: the editor previews a texture card straight off
     * `texture.data.src` (assetKinds.thumbnailOf), so revoking early leaves every texture card showing a
     * broken image.
     */
    public setObjectUrl(url: string): void {
        if (this._objectUrl && this._objectUrl !== url) URL.revokeObjectURL(this._objectUrl);
        this._objectUrl = url;
    }

    /** Release the blob: URL without touching the GL texture (for drop paths that don't own its lifetime). */
    public revokeObjectUrl(): void {
        if (this._objectUrl) { URL.revokeObjectURL(this._objectUrl); this._objectUrl = null; }
    }

    /**
     * The texture's original bytes as a data URL, or null if it wasn't created from bytes. Encoded on first
     * call and memoized — importing never pays for this, only saving does.
     */
    public get sourceUri(): string | null {
        if (this._sourceUri) return this._sourceUri;
        if (!this._source) return null;
        this._sourceUri = bytesToDataUrl(this._source.bytes, this._source.mime);
        return this._sourceUri;
    }
    public get texture(): WebGLTexture { return this._texture; }
    /**
     * The RHI texture underneath.
     *
     * Narrower than it looks: this is how a `Texture` becomes a `TextureView` and therefore a bind
     * group entry. `texture` above hands out the raw WebGL handle and is the thing the RHI is meant
     * to retire; this one hands out a resource the device already owns.
     */
    public get gpu(): WebGL2Texture { return this._gpu as WebGL2Texture; }

    /**
     * The device-owned texture, typed as the RHI describes one.
     *
     * The portable half of `gpu` above, which casts to the WebGL2 class and is what the unmigrated
     * upload callers still need. Anything that only has to hand the texture back to the device — a
     * bind group entry, a view — should read this instead, and the compute cloud-noise bake does.
     */
    public get rhiTexture(): RhiTexture { return this._gpu; }

    /**
     * This texture as an RHI view, created once and reused.
     *
     * Cached because the geometry pass builds a bind group per submesh per node — a fresh view object
     * per draw is pure garbage on a path that runs hundreds of times a frame. Views hold no GPU
     * resource on WebGL2, so one per texture is correct as well as cheap.
     */
    public get view(): WebGL2TextureView {
        if (!this._view) this._view = new WebGL2TextureView(this._gpu as WebGL2Texture);
        return this._view;
    }
    private _view: WebGL2TextureView | null = null;
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

    /** Rough VRAM footprint in bytes (width*height*depth * bytes-per-pixel * faces * mip factor). bpp
     *  mirrors the constructor's internalFormat choice (depth=4 / RGBA16F=8 / RGBA8=4). Used by the
     *  perf HUD. Without the depth term a 128³ volume would report as 64 KB rather than 8 MB. */
    public get byteSize(): number {
        this._syncGpuSize();
        return this._gpu.byteSize;
    }

    /**
     * Push the dimensions the upload paths established into the device texture.
     *
     * `_width`/`_height`/`_depth`/`_mipMap` are written from eight different upload entry points, and
     * this used to run lazily on the `byteSize` read so none of them had to remember. That stopped being
     * viable the moment a `TextureView` became a render-target attachment: `createRenderTarget` sizes
     * the target from `view.texture.width`, and a texture nobody had asked the byte size of still
     * reported 0 — which makes every pass into it a 1x1 viewport. So the sync is eager now, through the
     * one exit {@link _finishUpload} that every upload path already shared.
     */
    /**
     * Push the dimensions this wrapper holds into the device texture.
     *
     * Called BEFORE every upload as well as after, and the before is the load-bearing one. WebGL2 learns
     * a texture's size from the upload itself (`texImage2D` both allocates and fills), so this was only
     * ever bookkeeping there - `WebGL2Texture.setSize` records four numbers and touches no GL. A
     * `GPUTexture` fixes its size at creation and cannot be resized, so on WebGPU this call IS the
     * allocation, and an upload that ran first would have nothing to write into. Every allocate path
     * below therefore sets `_width`/`_height`/`_depth` and syncs before handing the data over.
     */
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
