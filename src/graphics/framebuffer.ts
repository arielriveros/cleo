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

    /**
     * Make this the current draw target, viewport included.
     *
     * `bind`/`unbind` are the LEGACY model, and the last thing keeping this class off the RHI
     * interface. Binding a framebuffer object is not a concept WebGPU has — there a target is named by
     * the pass that opens it and stops being current when the pass ends — so `RenderTarget.bind()` is
     * WebGL2-only and the cast below says so rather than widening the interface to accommodate it.
     *
     * They go away with the last draw that is not recorded against a pass encoder: every remaining
     * caller is a site that draws (or clears) outside a pass and therefore depends on inherited target
     * state. See the `glDevice()` worklist for the rest of that set.
     */
    public bind(): Framebuffer {
        (this.renderTarget as WebGL2RenderTarget).bind();
        return this;
    }

    /** Hand the canvas back the draw target — the default framebuffer, at its own resolution. */
    public unbind(): Framebuffer {
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

    /**
     * This framebuffer as an RHI render target.
     *
     * Asked for rather than held: the device dedupes targets by their attachment set, so repeating this
     * every pass is a map lookup and not an allocation, while `resize()` — which deletes every
     * attachment and therefore evicts the target — cannot leave a stale one behind. Holding one here
     * instead would mean two places that have to agree about when the attachments changed.
     */
    public get renderTarget(): RenderTarget {
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
