import { gl } from "./renderer";
import { Loader } from './loader';

export class Cubemap {
    private readonly _texture: WebGLTexture;
    private _images: {data: Uint8Array, width: number, height: number}[];

    constructor() {
        this._texture = gl.createTexture() as WebGLTexture;
        this._images = [];
    }

    private _loadImage(path: string): Promise<{data: Uint8Array, width: number, height: number}> {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.src = path;
            image.onload = () => {
                const data = new Uint8Array(image.width * image.height * 4);
                const canvas = document.createElement('canvas');
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext('2d');
                if (!context) throw new Error('Failed to create canvas context');
                context.drawImage(image, 0, 0);
                const imageData = context.getImageData(0, 0, image.width, image.height);
                data.set(imageData.data);
                resolve({
                    data: data,
                    width: image.width,
                    height: image.height
                });
            };
            image.onerror = () => reject();
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

        for (let i = 0; i < this._images.length; i++) {
            const image = this._images[i];
            gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, internalFormat, image.width, image.height, 0, format, type, image.data);
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

    public get texture(): WebGLTexture { return this._texture; }
    public get data(): {data: Uint8Array, width: number, height: number}[] { return this._images; }
}