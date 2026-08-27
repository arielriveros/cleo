import { glDevice } from './rhi/webgl2/webgl2Device';
import { device } from './rhi/deviceHandle';
import type { RenderTarget } from './rhi/resources';
import { Texture } from './texture';
import type { WebGL2RenderTarget } from './rhi/webgl2/webgl2Commands';

/**
 * A depth-only render target over one `TEXTURE_2D_ARRAY`, rendered a layer at a time: the cascaded
 * shadow map, and the spot-light shadow atlas. A pass picks its layer via `depthAttachment.baseArrayLayer`.
 */
export class LayeredDepthFramebuffer {
    private _texture: Texture;
    private _size: number = 0;
    private _layers: number = 0;

    constructor() {
        this._texture = new Texture({ usage: 'depth', target: 'texture2DArray', mipMap: false });
    }

    /**
     * (Re)allocate the array at `size` x `size` x `layers`. Immutable storage cannot be resized, so any
     * dimension change replaces the whole texture.
     */
    public create(size: number, layers: number, compare: boolean = true): void {
        if (this._size === size && this._layers === layers && this._texture.width === size) return;
        // Deleting the old array also evicts the render target it belonged to.
        this._texture.delete();
        this._texture = new Texture({ usage: 'depth', target: 'texture2DArray', mipMap: false });
        this._texture.createArrayTarget(size, layers, compare);
        this._size = size;
        this._layers = layers;
    }

    public unbind(): void {
        if (device.backend !== 'webgl2') return;

        glDevice().getCurrentSurfaceTarget().bind();
    }

    /**
     * Reset every layer to depth 1.0, so every shadow lookup passes and nothing is occluded. Required
     * when a scene has no casting light, or the layers keep the previous scene's shadows.
     */
    public clearAll(): void {
        const target = this.renderTarget;
        const encoder = device.createCommandEncoder('shadow.clear');
        for (let layer = 0; layer < this._layers; layer++) {
            encoder.beginRenderPass(target, {
                label: 'shadow.clear',
                colorAttachments: [],
                depthAttachment: { loadOp: 'clear', storeOp: 'store', baseArrayLayer: layer },
            }).end();
        }
        encoder.finish();
    }

    /**
     * Switch hardware depth comparison off/on. The editor's cascade debug blit needs it off to read
     * raw depth through a plain sampler2DArray.
     */
    public setCompareEnabled(enabled: boolean): void { this._texture.setDepthCompare(enabled); }

    /** Bind the whole array for SAMPLING on `unit`. */
    public bindTexture(unit: number): void { this._texture.bind(unit); }

    public delete(): void {
        this._texture.delete();
    }

    /** This array as an RHI render target: no colour attachments at all, one layered depth attachment. */
    public get renderTarget(): RenderTarget {
        return device.createRenderTarget({
            label: 'shadow-array',
            colorViews: [],
            depthView: this._texture.attachmentView,
        });
    }

    public get texture(): Texture { return this._texture; }
    public get size(): number { return this._size; }
    public get layers(): number { return this._layers; }
}
