import { gl } from './renderer';
import { Texture, TextureConfig } from './texture';

interface FrameBufferOptions {
    usage?: 'color' | 'depth';
    colorAttachments?: number;
    colorTextureOptions?: TextureConfig;
}

export class Framebuffer {
    private _id!: number;
    private _width: number;
    private _height: number;
    private _colors: Texture[];
    private _depth: Texture;
    private _options: FrameBufferOptions;

    constructor(options?: FrameBufferOptions) {
        this._id = gl.createFramebuffer() as number;
        this._width = 0;
        this._height = 0;
        this._options = {
            usage: options?.usage || 'color',
            colorAttachments: options?.colorAttachments || 1,
            colorTextureOptions: options?.colorTextureOptions || undefined
        };
        this._colors = [];
        this._depth = new Texture({usage: 'depth', repeat: false, mipMap: false});
    }

    public create(width: number, height: number): Framebuffer {
        this._width = width;
        this._height = height;

        gl.bindFramebuffer(gl.FRAMEBUFFER, this._id);

        const numColorAttachments = this._options.colorAttachments as number;
        const usage = this._options.usage;

        for (let i = 0; i < numColorAttachments; i++) {
            this._colors.push(new Texture(this._options.colorTextureOptions));
            this._colors[i].create(width, height);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, this._colors[i].texture, 0);
        }

        if (usage === 'color') { 
            const colorAttachments = [];
            for (let i = 0; i < numColorAttachments; i++)
                colorAttachments.push(gl.COLOR_ATTACHMENT0 + i);
            gl.drawBuffers(colorAttachments);
        }

        this._depth.create(width, height);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this._depth.texture, 0);

        if (usage === 'depth') {
            gl.drawBuffers([gl.NONE]);
            gl.readBuffer(gl.NONE);
        }

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

    public get colors(): Texture[] { return this._colors; }
    public get depth(): Texture { return this._depth; }
    public get width(): number { return this._width; }
    public get height(): number { return this._height; }
}