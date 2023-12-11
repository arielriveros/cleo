import { gl } from "./renderer";
import { Loader } from './loader';

interface TextureConfig {
    flipY: boolean;
}

export class Texture {
    private readonly _texture: WebGLTexture;
    private _width: number;
    private _height: number;
    private _usage: number;

    constructor(usage: number = gl.TEXTURE_2D) {
        this._texture = gl.createTexture() as WebGLTexture;
        this._width = 0;
        this._height = 0;
        this._usage = usage;
    }

    public createFromFile(path: string, config?: TextureConfig): Texture {
        try {
            Loader.loadImage(path).then((image) => this._create(image, config));
            return this;
        }
        catch (e) {
            throw new Error(`Error loading texture from path ${path}`);
        }
    }

    public bind(slot: number = 0): void {
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(this._usage, this._texture);
    }

    public unbind(): void {
        gl.bindTexture(this._usage, null);
    }

    private _create(data: HTMLImageElement, config?: TextureConfig): void {
        this.bind();
        this._width = data.width;
        this._height = data.height;

        // Flip Y
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !config?.flipY || false);

        gl.texImage2D(this._usage, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);

        gl.generateMipmap(gl.TEXTURE_2D);
        // Tex coordinates clamping to edge
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // Mipmapping
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        console.log(`Texture ${this._width}x${this._height} created`);

        // TODO: add support for multiple textures
        this.unbind();
    }

    public get width(): number { return this._width; }
    public get height(): number { return this._height; }
    public get texture(): WebGLTexture { return this._texture; }

}