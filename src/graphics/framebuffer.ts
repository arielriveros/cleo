import { gl } from './renderer';
import { Texture } from './texture';

export class Framebuffer {
    private _id!: number;
    private _width: number;
    private _height: number;
    private _texture: Texture;
    private _depth: Texture;

    constructor() {
        this._id = gl.createFramebuffer() as number;
        this._width = 0;
        this._height = 0;
        this._texture = new Texture();
        this._depth = new Texture('depth');
    }

    public create(width: number, height: number): Framebuffer {
        this._width = width;
        this._height = height;

        gl.bindFramebuffer(gl.FRAMEBUFFER, this._id);

        this._texture.create(width, height);
        this._depth.create(width, height);

        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._texture.texture, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this._depth.texture, 0);

        const framebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (framebufferStatus !== gl.FRAMEBUFFER_COMPLETE) {
            console.error('Framebuffer is not complete:', framebufferStatus);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return this;
    }

    public bind(): Framebuffer {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._id);
        gl.viewport(0, 0, this._width, this._height);

        return this;
    }

    public unbind(): Framebuffer {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

        return this;
    }

    public recreate(): void {
        this.create(this._width, this._height);
    }

    public resize(width: number, height: number): void {
        this._width = width;
        this._height = height;

        this.recreate();
    }

    public get texture(): Texture { return this._texture; }

    public get width(): number { return this._width; }

    public get height(): number { return this._height; }
}