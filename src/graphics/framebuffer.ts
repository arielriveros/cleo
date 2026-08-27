import { glDevice } from './rhi/webgl2/webgl2Device';
import { device } from './rhi/deviceHandle';
import type { RenderTarget } from './rhi/resources';
import type { ColorAttachmentDescriptor } from './rhi/types';
import type { WebGL2RenderTarget } from './rhi/webgl2/webgl2Commands';
import { Texture, TextureConfig } from './texture';

interface FrameBufferOptions {
    usage?: 'color' | 'depth';
    colorAttachments?: number;
    colorTextureOptions?: TextureConfig;
    /** Allocate a depth attachment. Default true; set false for depth-test-off fullscreen targets. */
    depth?: boolean;
}

/**
 * A screen-sized render target: N colour textures and an optional depth texture, reallocated together.
 * Owns the textures; the framebuffer object itself belongs to the device's render-target cache.
 */
export class Framebuffer {
    private _width: number;
    private _height: number;
    private _colors: Texture[];
    private _depth: Texture | null;
    private _options: FrameBufferOptions;

    constructor(options?: FrameBufferOptions) {
        this._width = 0;
        this._height = 0;
        this._options = {
            usage: options?.usage || 'color',
            colorAttachments: options?.colorAttachments || 1,
            colorTextureOptions: options?.colorTextureOptions || undefined,
            depth: options?.depth !== false
        };
        this._colors = [];
        this._depth = null;
    }

    public create(width: number, height: number): Framebuffer {
        this._width = width;
        this._height = height;

        // Deleting the old attachments also evicts the render target they belonged to.
        for (const color of this._colors) color.delete();
        this._colors = [];
        this._depth?.delete();
        this._depth = null;

        // `usage: 'depth'` means depth and nothing else — no colour attachments at all.
        if (this._options.usage === 'color') {
            for (let i = 0; i < (this._options.colorAttachments as number); i++) {
                const color = new Texture(this._options.colorTextureOptions);
                color.create(null, width, height);
                this._colors.push(color);
            }
        }

        if (this._options.depth !== false) {
            this._depth = new Texture({ usage: 'depth', mipMap: false });
            this._depth.create(null, width, height);
        }

        // Attaching, draw buffers and the completeness check all happen here.
        this.renderTarget;
        return this;
    }

    /** Make this the current draw target, viewport included. WebGL2 only; a no-op elsewhere. */
    public bind(): Framebuffer {
        if (device.backend !== 'webgl2') return this;
        (this.renderTarget as WebGL2RenderTarget).bind();
        return this;
    }

    /** Hand the canvas back the draw target — the default framebuffer, at its own resolution. */
    public unbind(): Framebuffer {
        if (device.backend !== 'webgl2') return this;
        glDevice().getCurrentSurfaceTarget().bind();
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

    /** This framebuffer as an RHI render target. Deduped by the device, so calling it per pass is free. */
    public get renderTarget(): RenderTarget {
        return device.createRenderTarget({
            label: 'framebuffer',
            colorViews: this._colors.map(c => c.attachmentView),
            depthView: this._depth ? this._depth.attachmentView : undefined,
        });
    }

    /** Release every attachment this target owns; the framebuffer object goes with them. */
    public destroy(): void {
        for (const color of this._colors) color.delete();
        this._colors = [];
        this._depth?.delete();
        this._depth = null;
    }
    public get colors(): Texture[] { return this._colors; }
    public get depth(): Texture { return this._depth!; }
    public get width(): number { return this._width; }
    public get height(): number { return this._height; }
}
