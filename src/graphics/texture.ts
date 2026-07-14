import { gl } from "./renderer";
import { bytesToDataUrl } from "../core/base64";

export interface TextureConfig {
    flipY?: boolean;
    usage?: 'color' | 'depth';
    wrapping?: 'clamp' | 'repeat' | 'mirror';
    mipMap?: boolean;
    mipMapFilter?: 'nearest' | 'linear';
    precision?: 'low' | 'high';
    target?: 'texture2D' | 'cubemap';
}

export interface CubemapFaces {
    posX: HTMLImageElement | null,
    negX: HTMLImageElement | null,
    posY: HTMLImageElement | null,
    negY: HTMLImageElement | null,
    posZ: HTMLImageElement | null,
    negZ: HTMLImageElement | null
}

export class Texture {
    private readonly _texture: WebGLTexture;
    private _width: number = 0;
    private _height: number = 0;
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

    constructor(options?: TextureConfig) {
        this._texture = gl.createTexture() as WebGLTexture;
        this._flipY = options?.flipY || false;
        this._usage = options?.usage || 'color';
        this._precision = options?.precision || 'low';
        this._mipMap = options?.mipMap === undefined ? true : options.mipMap;

        this._target = options?.target === 'cubemap' ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;

        this._wrapping = this._getWrappingValue(options?.wrapping) || gl.CLAMP_TO_EDGE;

        // Check for floating point texture support before using high precision
        const hasFloatTextureSupport = gl.getExtension('EXT_color_buffer_float') && gl.getExtension('OES_texture_float_linear');
        
        this._internalFormat = this._usage === 'depth' ? gl.DEPTH_COMPONENT24 : 
                              (this._precision === 'high' && hasFloatTextureSupport ? gl.RGBA16F : gl.RGBA8);

        this._minFilter = this._mipMap ? 
            (options?.mipMapFilter === 'nearest' ? gl.NEAREST_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR) :
            (options?.mipMapFilter === 'nearest' ? gl.NEAREST : gl.LINEAR);

        this._format = this._usage === 'depth' ? gl.DEPTH_COMPONENT : gl.RGBA;
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

    public bind(slot: number = 0): void {
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(this._target, this._texture);
    }

    public unbind(): void {
        gl.bindTexture(this._target, null);
    }

    public create(data: HTMLImageElement | CubemapFaces | null, width: number = 0, height: number = 0): void {
        this.bind();

        this._data = data;
        this._width = width;
        this._height = height;

        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !this._flipY);

        if (this._target === gl.TEXTURE_2D) {
            if (data) {
                const img = data as HTMLImageElement;
                console.log('Creating texture with image:', {
                    width: img.width,
                    height: img.height,
                    complete: img.complete,
                    naturalWidth: img.naturalWidth,
                    naturalHeight: img.naturalHeight,
                    src: img.src?.substring(0, 50) + '...'
                });
                
                // Validate image is properly loaded
                if (!img.complete || img.naturalWidth === 0) {
                    console.error('Image not properly loaded before texture creation');
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
            const faces = this._data as CubemapFaces;
            gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X, 0, this._internalFormat, this._format, this._type, faces.posX);
            gl.texImage2D(gl.TEXTURE_CUBE_MAP_NEGATIVE_X, 0, this._internalFormat, this._format, this._type, faces.negX);
            gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_Y, 0, this._internalFormat, this._format, this._type, faces.posY);
            gl.texImage2D(gl.TEXTURE_CUBE_MAP_NEGATIVE_Y, 0, this._internalFormat, this._format, this._type, faces.negY);
            gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_Z, 0, this._internalFormat, this._format, this._type, faces.posZ);
            gl.texImage2D(gl.TEXTURE_CUBE_MAP_NEGATIVE_Z, 0, this._internalFormat, this._format, this._type, faces.negZ);
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
        this.bind();
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
        this.bind();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texSubImage2D(this._target, 0, x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        this.unbind();
    }

    public updateImg(data: HTMLImageElement | null): void {
        if (this._target !== gl.TEXTURE_2D) {
            console.error('Cannot update 2D texture with cubemap face');
            return;
        }
        this.bind();
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
            console.error('Cannot set cubemap face on non-cubemap texture');
            return;
        }
        
        this.bind(); // Bind the texture before updating the face
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
        this.bind();
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

    /** (Re)generate the mip chain for this texture — e.g. after rendering a captured cubemap. */
    public generateMipmaps(): void {
        this.bind();
        gl.generateMipmap(this._target);
        this.unbind();
    }

    private checkForErrors(): void {
        const error = gl.getError();
        if (error !== gl.NO_ERROR) {
            console.error(`Error creating texture: ${error} with usage ${this._usage}, internal format ${this._internalFormat}, format ${this._format}`);
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
            target: this._target === gl.TEXTURE_2D ? 'texture2D' : 'cubemap'
        }
    }

    /** Rough VRAM footprint in bytes (width*height * bytes-per-pixel * faces * mip factor). bpp mirrors
     *  the constructor's internalFormat choice (depth=4 / RGBA16F=8 / RGBA8=4). Used by the perf HUD. */
    public get byteSize(): number {
        const bpp = this._usage === 'depth' ? 4 : (this._precision === 'high' ? 8 : 4);
        const faces = this._target === gl.TEXTURE_CUBE_MAP ? 6 : 1;
        const mip = this._mipMap ? 4 / 3 : 1;
        return this._width * this._height * bpp * faces * mip;
    }
}
