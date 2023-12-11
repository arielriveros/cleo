import { gl } from "./renderer";

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

    public createFromFile(path: string): Texture {
        try {
            this.loadFromPath(path).then((image) => this._create(image));
            return this;
        }
        catch (e) {
            throw new Error(`Error loading texture from path ${path}`);
        }
    }

    private async loadFromPath(path: string): Promise<HTMLImageElement> {
        return new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            image.src = path;
            image.onload = () => resolve(image);
            image.onerror = () => reject();
        });
    }

    public bind(slot: number = 0): void {
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(this._usage, this._texture);
    }

    public unbind(): void {
        gl.bindTexture(this._usage, null);
    }

    private _create(data: HTMLImageElement): void {
        this.bind();
        this._width = data.width;
        this._height = data.height;
        
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
        // Before creating a texutres flips (u,v) coords to match (x,y) coords
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
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