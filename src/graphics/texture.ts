import { gl } from "./renderer";
import { Loader } from './loader';

export interface TextureConfig {
    flipY?: boolean;
    usage?: 'color' | 'depth';
    wrapping?:  'clamp' | 'repeat' | 'mirror';
    mipMap?: boolean;
    mipMapFilter?: 'nearest' | 'linear';
    precision?: 'low' | 'high';
}

export class Texture {
    private readonly _texture: WebGLTexture;
    private _width: number;
    private _height: number;
    private _options: TextureConfig;

    constructor(options?: TextureConfig) {
        this._texture = gl.createTexture() as WebGLTexture;
        this._width = 0;
        this._height = 0;
        this._options = {
            flipY: options?.flipY || false,
            wrapping: options?.wrapping || 'clamp',
            usage: options?.usage || 'color',
            mipMapFilter: options?.mipMapFilter || 'linear',
            mipMap: options?.mipMap === undefined ? true : options.mipMap,
            precision: options?.precision || 'low'
        };
    }

    public createFromFile(path: string): Texture {
        try {
            Loader.loadImage(path).then((image) => this._create(image));
            return this;
        }
        catch (e) {
            throw new Error(`Error loading texture from path ${path}`);
        }
    }

    public create(width: number, height: number) {
        this._create(null, width, height);
        return this;
    }

    public bind(slot: number = 0): void {
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(gl.TEXTURE_2D, this._texture);
    }

    public unbind(): void {
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    private _create(data: HTMLImageElement | null, width: number = 0, height: number = 0): void {
        this.bind();

        if (data) {
            this._width = data.width;
            this._height = data.height;
        }
        else {
            this._width = width;
            this._height = height;
        }

        // Flip Y
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !this._options.flipY);

        let internalFormat;
        if (this._options.usage === 'depth')
            internalFormat = gl.DEPTH_COMPONENT24;
        else
            internalFormat = this._options.precision === 'low' ? gl.RGBA8 : gl.RGBA16F;

        let format = this._options.usage === 'depth' ? gl.DEPTH_COMPONENT : gl.RGBA;        
        let type = this._options.usage === 'depth' ? gl.UNSIGNED_INT : this._options.precision === 'low' ? gl.UNSIGNED_BYTE : gl.FLOAT ;

        if (data)
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, format, type, data);
        else
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, this._width, this._height, 0, format, type, null);

        if (this._options.usage === 'depth') {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }
        else {
            let minFilter;
            if (!this._options.mipMap)
                minFilter = this._options.mipMapFilter === 'nearest' ? gl.NEAREST : gl.LINEAR;
            else {
                gl.generateMipmap(gl.TEXTURE_2D);
                minFilter = this._options.mipMapFilter === 'nearest' ? gl.NEAREST_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR;
            }

            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            // Tex coordinates clamping to edge

            let wrapping;
            switch (this._options.wrapping) {
                case 'clamp':
                    wrapping = gl.CLAMP_TO_EDGE;
                    break;
                case 'repeat':
                    wrapping = gl.REPEAT;
                    break;
                case 'mirror':
                    wrapping = gl.MIRRORED_REPEAT;
                    break;
                default:
                    wrapping = gl.CLAMP_TO_EDGE;
                    break;
            }

            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapping);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapping);
        }

        // check for errors
        const error = gl.getError();
        if (error !== gl.NO_ERROR) {
            console.error(`Error creating texture: ${error} with usage ${this._options.usage}, internal format ${internalFormat}, format ${format}`);
        }

        this.unbind();
    }

    public get width(): number { return this._width; }
    public get height(): number { return this._height; }
    public get texture(): WebGLTexture { return this._texture; }

}