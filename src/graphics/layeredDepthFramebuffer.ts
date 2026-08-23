import { device } from './rhi/webgl2/webgl2Device';
import { Texture } from './texture';
import type { WebGL2RenderTarget } from './rhi/webgl2/webgl2Commands';

/**
 * A depth-only render target over one `TEXTURE_2D_ARRAY`, rendered a LAYER at a time.
 * This is the cascaded shadow map (and, for spot lights, the shadow atlas).
 *
 * What is left here is the ARRAY, not the framebuffer: immutable `texStorage3D` storage is allocated
 * exactly once and only the attachment changes per layer, which is why this could never share
 * `Framebuffer`'s reallocate-everything `create()`. Which layer a pass writes is the pass descriptor's
 * business (`depthAttachment.baseArrayLayer`) rather than the target's — the same split WebGPU makes,
 * and the reason one render target serves every cascade.
 */
export class LayeredDepthFramebuffer {
    private _texture: Texture;
    private _size: number = 0;
    private _layers: number = 0;

    constructor() {
        this._texture = new Texture({ usage: 'depth', target: 'texture2DArray', mipMap: false });
    }

    /**
     * (Re)allocate the array at `size` x `size` x `layers`. Immutable storage cannot be resized, so a
     * change in either dimension throws the whole texture away and builds a new one — which is why the
     * resolution and cascade-count setters share this one path in the renderer.
     */
    public create(size: number, layers: number, compare: boolean = true): void {
        if (this._size === size && this._layers === layers && this._texture.width === size) return;
        // Deleting the old array also evicts the render target it was attached to, so the next
        // `renderTarget` builds a framebuffer over the new storage. See WebGL2Device._releaseTexture.
        this._texture.delete();
        this._texture = new Texture({ usage: 'depth', target: 'texture2DArray', mipMap: false });
        this._texture.createArrayTarget(size, layers, compare);
        this._size = size;
        this._layers = layers;
    }

    public unbind(): void {
        device.getCurrentSurfaceTarget().bind();
    }

    /**
     * Reset every layer to depth 1.0, so every shadow lookup passes and nothing is occluded.
     * Used when a scene has no shadow-casting light: the depth pass is skipped entirely, and without
     * this the layers keep whatever the previously rendered scene left in them — which is how a
     * thumbnail or preview render inherits the shadows of the scene before it.
     *
     * A pass per layer with `loadOp: 'clear'` and nothing drawn. No explicit `clearDepth(1.0)` and no
     * `depthMask(true)`: the standing clear depth is 1.0 and nothing in the engine ever sets it
     * otherwise, and `beginRenderPass` forces the depth mask before clearing precisely because a GL
     * depth clear is masked by it while WebGPU's load op is not.
     */
    public clearAll(): void {
        const target = this.renderTarget;
        for (let layer = 0; layer < this._layers; layer++) {
            device.beginRenderPass(target, {
                label: 'shadow.clear',
                colorAttachments: [],
                depthAttachment: { loadOp: 'clear', storeOp: 'store', baseArrayLayer: layer },
            });
        }
        this.unbind();
    }

    /**
     * Switch hardware depth comparison off/on. Only the editor's cascade debug blit needs this: it
     * samples the array through a plain sampler2DArray to READ the depth, which is undefined while
     * the texture is in comparison mode.
     */
    public setCompareEnabled(enabled: boolean): void { this._texture.setDepthCompare(enabled); }

    /** Bind the whole array for SAMPLING on `unit`. */
    public bindTexture(unit: number): void { this._texture.bind(unit); }

    public delete(): void {
        this._texture.delete();
    }

    /** This array as an RHI render target: no colour attachments at all, one layered depth attachment. */
    public get renderTarget(): WebGL2RenderTarget {
        return device.createRenderTarget({
            label: 'shadow-array',
            colorViews: [],
            depthView: this._texture.view,
        });
    }

    public get texture(): Texture { return this._texture; }
    public get size(): number { return this._size; }
    public get layers(): number { return this._layers; }
}
