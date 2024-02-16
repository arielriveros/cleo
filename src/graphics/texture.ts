import { gl } from "./renderer";

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

        this._internalFormat = this._usage === 'depth' ? gl.DEPTH_COMPONENT24 : (this._precision === 'high' ? gl.RGBA16F : gl.RGBA);

        this._minFilter = this._mipMap ? 
            (options?.mipMapFilter === 'nearest' ? gl.NEAREST_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR) :
            (options?.mipMapFilter === 'nearest' ? gl.NEAREST : gl.LINEAR);

        this._format = this._usage === 'depth' ? gl.DEPTH_COMPONENT : gl.RGBA;
        this._type = this._usage === 'depth' ? gl.UNSIGNED_INT : 
                     (this._precision === 'low' ? gl.UNSIGNED_BYTE : gl.FLOAT);
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

        if (this._target === gl.TEXTURE_2D)
            gl.texImage2D(this._target, 0, this._internalFormat, this._width, this._height, 0, this._format, this._type, this._data as HTMLImageElement | null);
        else {
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

    public updateImg(data: HTMLImageElement | null): void {
        if (this._target !== gl.TEXTURE_2D) {
            console.error('Cannot update 2D texture with cubemap face');
            return;
        }
        this.bind();
        this._data = data;
        this._width = data.width;
        this._height = data.height;
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !this._flipY);
        gl.texImage2D(this._target, 0, this._internalFormat, this._width, this._height, 0, this._format, this._type, this._data as HTMLImageElement | null);
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
        gl.texImage2D(target, 0, this._internalFormat, this._width, this._height, 0, this._format, this._type, data);
        if (this._mipMap) {
            gl.generateMipmap(this._target);
        }
        this.checkForErrors();
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
    }

    public get data(): HTMLImageElement | CubemapFaces | null { return this._data; }
    public get width(): number { return this._width; }
    public get height(): number { return this._height; }
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
}
