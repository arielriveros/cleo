import { gl } from "./renderer";
import { Loader } from './loader';

export class Cubemap {
    private readonly _texture: WebGLTexture;
    private _images: HTMLImageElement[];
    private _width: number;
    private _height: number;

    constructor() {
        this._texture = gl.createTexture() as WebGLTexture;
        this._width = 0;
        this._height = 0;
        this._images = [];
    }

    public createFromFiles(paths: string[]): Cubemap {
        try {
            const promises = paths.map(path => Loader.loadImage(path));
    
            Promise.all(promises)
                .then(images => this._images.push(...images))
                .then(() => this._create());
    
            return this;
        } catch (e) {
            throw new Error(`Error loading texture from paths: ${paths}`);
        }
    }

    public create(width: number, height: number) {
        this._create(width, height);
        return this;
    }

    public bind(slot: number = 0): void {
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, this._texture);
    }

    public unbind(): void {
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    }

    private _create(width: number = 0, height: number = 0): void {
        this.bind();

        if (this._images.length !== 6) {
            this._width = this._images[0].width;
            this._height = this._images[0].height;
        }
        else {
            this._width = width;
            this._height = height;
        }

        // Flip Y
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

        let internalFormat = gl.RGBA;
        let format = gl.RGBA;
        let type = gl.UNSIGNED_BYTE;

        for (let i = 0; i < this._images.length; i++) {
            gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, internalFormat, format, type, this._images[i]);
        }

        gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        // Tex coordinates clamping to edge
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE); 
        // check for errors
        const error = gl.getError();
        if (error !== gl.NO_ERROR)
            console.error(`Error creating cubmap: ${error}`);

        this.unbind();
    }

    public get width(): number { return this._width; }
    public get height(): number { return this._height; }
    public get texture(): WebGLTexture { return this._texture; }

}