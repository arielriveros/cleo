import { gl } from "./renderer";
import { Loader } from './loader';

export class Cubemap {
    private readonly _texture: WebGLTexture;
    private _images: HTMLImageElement[];

    constructor() {
        this._texture = gl.createTexture() as WebGLTexture;
        this._images = [];
    }

    private _loadImage(path: string): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            Loader.loadImage(path).then(image => {
                resolve(image);
            })
            .catch(err => reject(err));
        });
    }

    public createFromFiles(paths: string[]): Cubemap {
        try {
            const promises = paths.map(path => this._loadImage(path));
            Promise.all(promises)
            .then(images => {
                this._images = images;
                this._create();
            })
    
            return this;
        } catch (e) {
            throw new Error(`Error loading texture from paths: ${paths}`);
        }
    }

    public create() {
        this._create();
        return this;
    }

    public bind(slot: number = 0): void {
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, this._texture);
    }

    public unbind(): void {
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    }

    private _create(): void {
        this.bind();

        // Flip Y
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

        let internalFormat = gl.RGBA;
        let format = gl.RGBA;
        let type = gl.UNSIGNED_BYTE;

        for (let i = 0; i < this._images.length; i++)
            gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, internalFormat, format, type, this._images[i]);

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

    public get texture(): WebGLTexture { return this._texture; }
    public get data(): HTMLImageElement[] { return this._images; }
}