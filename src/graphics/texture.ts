import { gl } from "./glContext";
import { GLState } from "./systems/glState";
import { bytesToDataUrl } from "../core/base64";
import { Logger } from "../core/logger";

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

export class Texture {
    private readonly _texture: WebGLTexture;
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
    private _target: number;
    private _internalFormat: number;
    private _mipMap: boolean;
    private _minFilter: number;
    private _format: number;
    private _type: number;
    // Unit this texture was last bound to, so `unbind()` releases that unit rather than assuming 0.
    private _boundSlot: number = 0;

    constructor(options?: TextureConfig) {
        this._texture = gl.createTexture() as WebGLTexture;
        this._flipY = options?.flipY || false;
        this._usage = options?.usage || 'color';
        this._precision = options?.precision || 'low';
        this._mipMap = options?.mipMap === undefined ? true : options.mipMap;

        this._target = options?.target === 'cubemap' ? gl.TEXTURE_CUBE_MAP
                     : options?.target === 'texture3D' ? gl.TEXTURE_3D
                     : options?.target === 'texture2DArray' ? gl.TEXTURE_2D_ARRAY
                     : gl.TEXTURE_2D;

        this._wrapping = this._getWrappingValue(options?.wrapping) || gl.CLAMP_TO_EDGE;

        // Check for floating point texture support before using high precision
        const hasFloatTextureSupport = gl.getExtension('EXT_color_buffer_float') && gl.getExtension('OES_texture_float_linear');
        
        const singleChannel = options?.channels === 'r' && this._usage !== 'depth';
        this._internalFormat = this._usage === 'depth' ? gl.DEPTH_COMPONENT24 :
                              singleChannel ? (this._precision === 'high' && hasFloatTextureSupport ? gl.R16F : gl.R8) :
                              (this._precision === 'high' && hasFloatTextureSupport ? gl.RGBA16F : gl.RGBA8);

        this._minFilter = this._mipMap ? 
            (options?.mipMapFilter === 'nearest' ? gl.NEAREST_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR) :
            (options?.mipMapFilter === 'nearest' ? gl.NEAREST : gl.LINEAR);

        this._format = this._usage === 'depth' ? gl.DEPTH_COMPONENT : (singleChannel ? gl.RED : gl.RGBA);
        this._channels = singleChannel ? 1 : 4;
        this._type = this._usage === 'depth' ? gl.UNSIGNED_INT : 
                     (this._precision === 'low' || !hasFloatTextureSupport ? gl.UNSIGNED_BYTE : gl.FLOAT);
    }

    private _getWrappingValue(wrapping?: 'clamp' | 'repeat' | 'mirror'): number {
        switch (wrapping) {
            case 'clamp':
                return gl.CLAMP_TO_EDGE;
            case 'repeat':
                return gl.REPEAT;
            case 'mirror':
                return gl.MIRRORED_REPEAT;
            default:
                return gl.CLAMP_TO_EDGE;
        }
    }

    /**
     * Bind for *sampling*, through the GL state cache — a rebind of the texture already on that unit
     * costs nothing. This is the frame's hottest bind path (every material map on every draw), and it
     * was the one hole left in the state cache: `GLState.bindTexture` existed but nothing called it.
     */
    public bind(slot: number = 0): void {
        this._boundSlot = slot;
        GLState.bindTexture(slot, this._target, this._texture);
    }

    /**
     * Bind for *mutation* (texImage/texParameter/generateMipmap), which all act on the active unit —
     * so this forces both the unit and the binding rather than letting the cache elide either.
     */
    private _bindForUpload(): void {
        this._boundSlot = 0;
        GLState.bindTextureForced(0, this._target, this._texture);
    }

    /** Release whichever unit this texture was last bound to. */
    public unbind(): void {
        GLState.bindTexture(this._boundSlot, this._target, null);
    }

    public create(data: HTMLImageElement | CubemapFaces | null, width: number = 0, height: number = 0): void {
        this._bindForUpload();

        this._data = data;
        this._width = width;
        this._height = height;

        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !this._flipY);

        if (this._target === gl.TEXTURE_2D) {
            if (data) {
                const img = data as HTMLImageElement;
                Logger.print('info', ['Creating texture with image:', {
                    width: img.width,
                    height: img.height,
                    complete: img.complete,
                    naturalWidth: img.naturalWidth,
                    naturalHeight: img.naturalHeight,
                    src: img.src?.substring(0, 50) + '...'
                }], 'Texture');

                // Validate image is properly loaded
                if (!img.complete || img.naturalWidth === 0) {
                    Logger.error('Image not properly loaded before texture creation', 'Texture');
                    this.unbind();
                    return;
                }
                
                // When using HTMLImageElement, use the 6-parameter version
                gl.texImage2D(this._target, 0, this._internalFormat, this._format, this._type, img);
            } else {
                // When using null data (for render targets), use the 9-parameter version
                gl.texImage2D(this._target, 0, this._internalFormat, this._width, this._height, 0, this._format, this._type, null);
            }
        } else {
            const CUBE_FACES = [
                gl.TEXTURE_CUBE_MAP_POSITIVE_X, gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
                gl.TEXTURE_CUBE_MAP_POSITIVE_Y, gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
                gl.TEXTURE_CUBE_MAP_POSITIVE_Z, gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
            ];
            if (data) {
                const faces = data as CubemapFaces;
                const images = [faces.posX, faces.negX, faces.posY, faces.negY, faces.posZ, faces.negZ];
                for (let i = 0; i < CUBE_FACES.length; i++)
                    gl.texImage2D(CUBE_FACES[i], 0, this._internalFormat, this._format, this._type, images[i]);
            } else {
                // Null data on a cubemap used to walk straight into `faces.posX` and throw a TypeError —
                // the null path existed only on the TEXTURE_2D side above, even though `new Skybox(null)`
                // reaches exactly here and the public signature openly accepts null. Allocate six empty
                // faces instead, mirroring what the 2D branch does for render targets: a no-op would leave
                // the texture incomplete, which is a subtler failure than the crash it replaced.
                for (const face of CUBE_FACES)
                    gl.texImage2D(face, 0, this._internalFormat, this._width, this._height, 0, this._format, this._type, null);
            }
        }

        const textureParams = this._usage === 'depth' ? 
            [gl.NEAREST, gl.NEAREST, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE] :
            [this._minFilter, gl.LINEAR, this._wrapping, this._wrapping];

        gl.texParameteri(this._target, gl.TEXTURE_MIN_FILTER, textureParams[0]);
        gl.texParameteri(this._target, gl.TEXTURE_MAG_FILTER, textureParams[1]);
        gl.texParameteri(this._target, gl.TEXTURE_WRAP_S, textureParams[2]);
        gl.texParameteri(this._target, gl.TEXTURE_WRAP_T, textureParams[3]);

        if (this._mipMap) {
            gl.generateMipmap(this._target);
        }

        this.checkForErrors();

        this.unbind();
    }

    /**
     * Create the texture from a raw RGBA byte array (e.g. an editable splat map). No mipmaps/flip so the
     * data maps 1:1 to UVs, and it can be partially updated later with `updateRegion`.
     */
    public createFromData(data: Uint8Array, width: number, height: number, wrapping: 'clamp' | 'repeat' | 'mirror' = 'clamp'): void {
        this._bindForUpload();
        this._data = null;
        this._width = width;
        this._height = height;
        const wrap = this._getWrappingValue(wrapping);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(this._target, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.texParameteri(this._target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(this._target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(this._target, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(this._target, gl.TEXTURE_WRAP_T, wrap);
        this.checkForErrors();
        this.unbind();
    }

    /** Upload a sub-rectangle of RGBA bytes (row-major, tightly packed) into an existing data texture. */
    public updateRegion(x: number, y: number, width: number, height: number, data: Uint8Array): void {
        this._bindForUpload();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texSubImage2D(this._target, 0, x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        this.unbind();
    }

    public updateImg(data: HTMLImageElement | null): void {
        if (this._target !== gl.TEXTURE_2D) {
            Logger.error('Cannot update 2D texture with cubemap face', 'Texture');
            return;
        }
        this._bindForUpload();
        this._data = data;
        if (data) {
            this._width = data.width;
            this._height = data.height;
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !this._flipY);
            // Use the 6-parameter version for HTMLImageElement
            gl.texImage2D(this._target, 0, this._internalFormat, this._format, this._type, data);
        } else {
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !this._flipY);
            // Use the 9-parameter version for null data
            gl.texImage2D(this._target, 0, this._internalFormat, this._width, this._height, 0, this._format, this._type, null);
        }
        if (this._mipMap) {
            gl.generateMipmap(this._target);
        }
        this.checkForErrors();
        this.unbind();
    }

    public updateFace(face: 'posX' | 'negX' | 'posY' | 'negY' | 'posZ' | 'negZ', data: HTMLImageElement): void {
        if (this._target !== gl.TEXTURE_CUBE_MAP) {
            Logger.error('Cannot set cubemap face on non-cubemap texture', 'Texture');
            return;
        }
        
        this._bindForUpload(); // Bind the texture before updating the face
        let target = 0;
        switch (face) {
            case 'posX':
                target = gl.TEXTURE_CUBE_MAP_POSITIVE_X;
                (this._data as CubemapFaces).posX = data;
                break;
            case 'negX':
                target = gl.TEXTURE_CUBE_MAP_NEGATIVE_X;
                (this._data as CubemapFaces).negX = data;
                break;
            case 'posY':
                target = gl.TEXTURE_CUBE_MAP_POSITIVE_Y;
                (this._data as CubemapFaces).posY = data;
                break;
            case 'negY':
                target = gl.TEXTURE_CUBE_MAP_NEGATIVE_Y;
                (this._data as CubemapFaces).negY = data;
                break;
            case 'posZ':
                target = gl.TEXTURE_CUBE_MAP_POSITIVE_Z;
                (this._data as CubemapFaces).posZ = data;
                break;
            case 'negZ':
                target = gl.TEXTURE_CUBE_MAP_NEGATIVE_Z;
                (this._data as CubemapFaces).negZ = data;
                break;
        }
        this._width = data.width;
        this._height = data.height;
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !this._flipY);
        gl.texImage2D(target, 0, this._internalFormat, this._format, this._type, data);
        if (this._mipMap) {
            gl.generateMipmap(this._target);
        }
        this.checkForErrors();
        this.unbind();        
    }

    /**
     * Allocate an empty renderable cubemap (all 6 faces) with immutable storage, sized `size` per
     * face and `levels` mip levels. Used as an IBL render target (captured environment, irradiance,
     * prefiltered specular) — render into a face/level with a framebuffer, then sample as a cubemap.
     */
    public createCubemapTarget(size: number, levels: number = 1): void {
        this._bindForUpload();
        this._width = size;
        this._height = size;
        this._mipMap = levels > 1;
        gl.texStorage2D(gl.TEXTURE_CUBE_MAP, levels, this._internalFormat, size, size);

        const minFilter = levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, minFilter);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
        this.unbind();
    }

    /**
     * Allocate an empty renderable 3D volume with immutable storage. Requires `target: 'texture3D'`.
     *
     * Immutable storage (`texStorage3D` rather than `texImage3D`) is deliberate: it is what makes the
     * texture's layers valid attachment targets for `gl.framebufferTextureLayer`, which is how the
     * volume gets filled — one fullscreen draw per z-slice. Generating a 128³ field on the CPU would
     * be tens of millions of noise evaluations in JS; on the GPU it is one frame's work, once.
     *
     * Wrapping defaults to REPEAT on all three axes, including WRAP_R (which the 2D path never sets),
     * because the only consumer so far is a *tileable* noise field whose whole purpose is to repeat.
     */
    public createVolume(width: number, height: number, depth: number,
                        wrapping: 'clamp' | 'repeat' | 'mirror' = 'repeat'): void {
        if (this._target !== gl.TEXTURE_3D) {
            Logger.error('createVolume requires a texture created with target: "texture3D"', 'Texture');
            return;
        }
        this._bindForUpload();
        this._width = width;
        this._height = height;
        this._depth = depth;
        this._mipMap = false; // a tiling noise field wants a single level; mips would blur the tile seams

        gl.texStorage3D(gl.TEXTURE_3D, 1, this._internalFormat, width, height, depth);

        const wrap = this._getWrappingValue(wrapping);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, wrap);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, wrap);
        this.checkForErrors();
        this.unbind();
    }

    /**
     * Allocate an empty renderable DEPTH texture array with immutable storage. Requires
     * `target: 'texture2DArray'` and `usage: 'depth'`. This is the cascaded-shadow-map target: one
     * layer per cascade, filled through `gl.framebufferTextureLayer` (see LayeredDepthFramebuffer).
     *
     * Two things here differ from every other depth texture in the engine, and both are the point:
     *
     *  - One array replaces N separate `sampler2D`s. GLSL ES 3.00 forbids dynamically indexing a
     *    SAMPLER array, which is why the old three-cascade code had to unroll its cascade select into
     *    an if-chain and burn three texture units. A `sampler2DArray` takes a dynamic layer index, so
     *    the cascade count becomes a plain uniform and the whole thing costs one unit.
     *  - `compare` turns it into a `sampler2DArrayShadow`: the hardware does the depth comparison and
     *    bilinearly filters the RESULT, so one tap is already a 2x2 percentage-closer filter. That is
     *    why this path must NOT inherit `create()`'s forced NEAREST for depth textures.
     */
    public createArrayTarget(size: number, layers: number, compare: boolean = true): void {
        if (this._target !== gl.TEXTURE_2D_ARRAY) {
            Logger.error('createArrayTarget requires a texture created with target: "texture2DArray"', 'Texture');
            return;
        }
        this._bindForUpload();
        this._width = size;
        this._height = size;
        this._depth = layers;
        this._mipMap = false;

        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, this._internalFormat, size, size, layers);

        const filter = compare ? gl.LINEAR : gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
        // CLAMP, not REPEAT: a lookup that falls outside a cascade's footprint must read the border,
        // not wrap around and shadow the far side of the map with unrelated geometry.
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (compare) {
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.LESS);
        }
        this.checkForErrors();
        this.unbind();
    }

    /**
     * Toggle hardware depth comparison on a depth array/2D target.
     *
     * Reading a texture whose TEXTURE_COMPARE_MODE is COMPARE_REF_TO_TEXTURE through a NON-shadow
     * sampler is undefined per the GLES 3.0 spec, so the editor's cascade debug blit — which wants
     * the stored depth, not a comparison result — has to switch the mode off around its draw.
     */
    public setDepthCompare(enabled: boolean): void {
        this._bindForUpload();
        gl.texParameteri(this._target, gl.TEXTURE_COMPARE_MODE, enabled ? gl.COMPARE_REF_TO_TEXTURE : gl.NONE);
        gl.texParameteri(this._target, gl.TEXTURE_MIN_FILTER, enabled ? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(this._target, gl.TEXTURE_MAG_FILTER, enabled ? gl.LINEAR : gl.NEAREST);
        this.unbind();
    }

    /** (Re)generate the mip chain for this texture — e.g. after rendering a captured cubemap. */
    public generateMipmaps(): void {
        this._bindForUpload();
        gl.generateMipmap(this._target);
        this.unbind();
    }

    private checkForErrors(): void {
        const error = gl.getError();
        if (error !== gl.NO_ERROR) {
            Logger.error(`Error creating texture: ${error} with usage ${this._usage}, internal format ${this._internalFormat}, format ${this._format}`, 'Texture');
        }
    }

    public delete(): void {
        gl.deleteTexture(this._texture);
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
    public get config(): TextureConfig {
        return {
            flipY: this._flipY,
            usage: this._usage,
            wrapping: this._wrapping === gl.CLAMP_TO_EDGE ? 'clamp' : this._wrapping === gl.REPEAT ? 'repeat' : 'mirror',
            mipMap: this._mipMap,
            mipMapFilter: this._minFilter === gl.NEAREST_MIPMAP_NEAREST ? 'nearest' : 'linear',
            precision: this._precision,
            target: this._target === gl.TEXTURE_2D ? 'texture2D'
                  : this._target === gl.TEXTURE_3D ? 'texture3D'
                  : this._target === gl.TEXTURE_2D_ARRAY ? 'texture2DArray' : 'cubemap'
        }
    }

    /** Slices of a 3D volume or layers of a 2D array; 0 for plain 2D and cubemap textures. */
    public get depth(): number { return this._depth; }

    /** Rough VRAM footprint in bytes (width*height*depth * bytes-per-pixel * faces * mip factor). bpp
     *  mirrors the constructor's internalFormat choice (depth=4 / RGBA16F=8 / RGBA8=4). Used by the
     *  perf HUD. Without the depth term a 128³ volume would report as 64 KB rather than 8 MB. */
    public get byteSize(): number {
        const bytesPerChannel = this._precision === 'high' ? 2 : 1;
        const bpp = this._usage === 'depth' ? 4 : this._channels * bytesPerChannel;
        const faces = this._target === gl.TEXTURE_CUBE_MAP ? 6 : 1;
        const slices = (this._target === gl.TEXTURE_3D || this._target === gl.TEXTURE_2D_ARRAY) ? Math.max(1, this._depth) : 1;
        // 4/3 is the 2D mip series; a 3D chain converges to 8/7 instead.
        const mip = this._mipMap ? (this._target === gl.TEXTURE_3D ? 8 / 7 : 4 / 3) : 1;
        return this._width * this._height * slices * bpp * faces * mip;
    }
}
