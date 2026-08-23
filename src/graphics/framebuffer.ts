import { gl } from './glContext';
import { device } from './rhi/webgl2/webgl2Device';
import type { ColorAttachmentDescriptor } from './rhi/types';
import type { WebGL2Framebuffer } from './rhi/webgl2/webgl2Device';
import { WebGL2RenderTarget, WebGL2TextureView } from './rhi/webgl2/webgl2Commands';
import { Texture, TextureConfig } from './texture';
import { Logger } from '../core/logger';
import { setViewportSize } from './renderStats';

interface FrameBufferOptions {
    usage?: 'color' | 'depth';
    colorAttachments?: number;
    colorTextureOptions?: TextureConfig;
    /**
     * Allocate a depth attachment. Default true. Set false for targets that only ever receive
     * fullscreen passes with depth testing off — every framebuffer used to get a
     * DEPTH_COMPONENT24 texture whether or not anything could possibly read or write it.
     */
    depth?: boolean;
}

export class Framebuffer {
    // Was typed `number` and cast through `unknown` to WebGLFramebuffer at the getter — a lie the
    // compiler could not catch. The device hands back a real object with a real lifetime.
    private _id: WebGL2Framebuffer;
    private _width: number;
    private _height: number;
    private _colors: Texture[];
    private _depth: Texture;
    private _options: FrameBufferOptions;

    constructor(options?: FrameBufferOptions) {
        this._id = device.createFramebuffer('framebuffer');
        this._width = 0;
        this._height = 0;
        this._options = {
            usage: options?.usage || 'color',
            colorAttachments: options?.colorAttachments || 1,
            colorTextureOptions: options?.colorTextureOptions || undefined,
            depth: options?.depth !== false
        };
        this._colors = [];
        this._depth = new Texture({usage: 'depth', mipMap: false});
    }

    public create(width: number, height: number): Framebuffer {
        this._width = width;
        this._height = height;

        // Release any textures from a previous create()/resize() so we don't leak GPU memory
        // (and grow the _colors array) every time the viewport is resized.
        for (const color of this._colors) color.delete();
        this._colors = [];
        this._depth.delete();
        this._depth = new Texture({ usage: 'depth', mipMap: false });

        this._id.bind();

        const numColorAttachments = this._options.colorAttachments as number;
        const usage = this._options.usage;

        for (let i = 0; i < numColorAttachments; i++) {
            this._colors.push(new Texture(this._options.colorTextureOptions));
            this._colors[i].create(null, width, height);
            this._id.attachColor2D(i, this._colors[i].texture);
        }

        if (usage === 'color') this._id.setDrawBuffers(numColorAttachments);

        if (this._options.depth !== false) {
            this._depth.create(null, width, height);
            this._id.attachDepth2D(this._depth.texture);
        }

        if (usage === 'depth') this._id.setDrawBuffers(0);

        this._id.checkStatus('create');

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return this;
    }

    public bind(): Framebuffer {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._id.handle);
        gl.viewport(0, 0, this._width, this._height);
        setViewportSize(this._width, this._height);

        return this;
    }

    public unbind(): Framebuffer {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        setViewportSize(gl.canvas.width, gl.canvas.height);

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

    public get framebuffer(): WebGLFramebuffer { return this._id.handle; }

    /**
     * Open a render pass on this target: bind it, set the viewport, and clear what was asked for.
     *
     * The pass boundary, in one call. `bind()` and `gl.clear()` were only ever adjacent by convention,
     * and nothing stopped a pass binding and forgetting to clear — which produced a frame of the
     * previous pass's contents rather than an error.
     *
     * The descriptor names every colour attachment this framebuffer actually has, not just slot 0:
     * `gl.clear` clears them all, and a descriptor that claimed otherwise would be a lie the WebGPU
     * backend would then faithfully implement as something different.
     */
    public beginPass(label: string, clear: { color?: boolean; depth?: boolean } = {}): void {
        const colorAttachments: ColorAttachmentDescriptor[] = [];
        for (let i = 0; i < this._colors.length; i++)
            colorAttachments.push({ target: i, loadOp: clear.color ? 'clear' : 'load', storeOp: 'store' });
        device.beginRenderPass(
            { framebuffer: this._id, width: this._width, height: this._height },
            {
                label,
                colorAttachments,
                depthAttachment: this._options.depth !== false
                    ? { loadOp: clear.depth ? 'clear' : 'load', storeOp: 'store' }
                    : undefined,
            },
        );
    }

    /**
     * This framebuffer as an RHI render target.
     *
     * Rebuilt on demand rather than cached: `resize()` reallocates every attachment, and a cached
     * target holding views of the old textures would keep rendering into storage nothing samples.
     */
    public get renderTarget(): WebGL2RenderTarget {
        return new WebGL2RenderTarget(
            this._id, this._width, this._height,
            this._colors.map(c => new WebGL2TextureView(c.gpu)),
            this._options.depth !== false ? new WebGL2TextureView(this._depth.gpu) : undefined,
            'framebuffer');
    }

    /** Release the framebuffer object and every attachment it owns. */
    public destroy(): void {
        for (const color of this._colors) color.delete();
        this._colors = [];
        this._depth.delete();
        this._id.destroy();
    }
    public get colors(): Texture[] { return this._colors; }
    public get depth(): Texture { return this._depth; }
    public get width(): number { return this._width; }
    public get height(): number { return this._height; }
}