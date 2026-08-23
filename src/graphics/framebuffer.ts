import { device } from './rhi/webgl2/webgl2Device';
import type { ColorAttachmentDescriptor } from './rhi/types';
import type { WebGL2RenderTarget } from './rhi/webgl2/webgl2Commands';
import { Texture, TextureConfig } from './texture';

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

/**
 * A screen-sized render target: N colour textures and an optional depth texture, reallocated together.
 *
 * Owns the TEXTURES and nothing else. The framebuffer object, the attachment calls and the completeness
 * check all live in {@link WebGL2Device.createRenderTarget} now, which is what let this class,
 * `CubeFramebuffer` and `LayeredDepthFramebuffer` collapse onto one shape: the three differed only in
 * which `TextureView`s they attached, and a view carries its own mip level and array layer.
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

        // Release any textures from a previous create()/resize() so we don't leak GPU memory
        // (and grow the _colors array) every time the viewport is resized. Deleting them also evicts
        // the render target they were attached to — see WebGL2Device._releaseTexture — so the target
        // rebuilt below is a new framebuffer over the new storage rather than a stale one.
        for (const color of this._colors) color.delete();
        this._colors = [];
        this._depth?.delete();
        this._depth = null;

        // `usage: 'depth'` means depth and nothing else. It used to allocate a full-size colour texture
        // anyway and then set draw buffers to NONE, so the texture could never be written or read — a
        // whole screen-sized RGBA8 target per depth framebuffer, paid for and unreachable.
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

    /** Make this the current draw target, viewport included. */
    public bind(): Framebuffer {
        this.renderTarget.bind();
        return this;
    }

    /** Hand the canvas back the draw target — the default framebuffer, at its own resolution. */
    public unbind(): Framebuffer {
        device.getCurrentSurfaceTarget().bind();
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

    public get framebuffer(): WebGLFramebuffer { return this.renderTarget.framebuffer!.handle; }

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
        device.beginRenderPass(this.renderTarget, {
            label,
            colorAttachments,
            depthAttachment: this._depth
                ? { loadOp: clear.depth ? 'clear' : 'load', storeOp: 'store' }
                : undefined,
        });
    }

    /**
     * This framebuffer as an RHI render target.
     *
     * Asked for rather than held: the device dedupes targets by their attachment set, so repeating this
     * every pass is a map lookup and not an allocation, while `resize()` — which deletes every
     * attachment and therefore evicts the target — cannot leave a stale one behind. Holding one here
     * instead would mean two places that have to agree about when the attachments changed.
     */
    public get renderTarget(): WebGL2RenderTarget {
        return device.createRenderTarget({
            label: 'framebuffer',
            colorViews: this._colors.map(c => c.view),
            depthView: this._depth ? this._depth.view : undefined,
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
