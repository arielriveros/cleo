import { gl } from "./renderer";
import { Loader } from './loader';

interface TextureConfig {
    flipY?: boolean;
    repeat?: boolean;
}

export class Texture {
    private readonly _texture: WebGLTexture;
    private _width: number;
    private _height: number;
    private _usage: 'color' | 'depth';

    constructor(usage: 'color' | 'depth' = 'color') {
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

    public create(width: number, height: number, config?: TextureConfig) {
        this._create(null, config, width, height);
        return this;
    }

    public bind(slot: number = 0): void {
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(gl.TEXTURE_2D, this._texture);
    }

    public unbind(): void {
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    private _create(data: HTMLImageElement | null, config?: TextureConfig, width: number = 0, height: number = 0): void {
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
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !config?.flipY || false);

        if (data) {
            if (this._usage === 'depth')
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, data);
            else
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
        }
        else {
            if (this._usage === 'depth')
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, this._width, this._height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
            else
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this._width, this._height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }

        gl.generateMipmap(gl.TEXTURE_2D);
        // Tex coordinates clamping to edge
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, config?.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, config?.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
        // Mipmapping
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        this.unbind();
    }

    public get width(): number { return this._width; }
    public get height(): number { return this._height; }
    public get texture(): WebGLTexture { return this._texture; }

}