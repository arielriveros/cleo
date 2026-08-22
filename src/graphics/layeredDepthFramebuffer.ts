import { gl } from './glContext';
import { device } from './rhi/webgl2/webgl2Device';
import type { WebGL2Framebuffer } from './rhi/webgl2/webgl2Device';
import { GLState } from './systems/glState';
import { Logger } from '../core/logger';
import { setViewportSize } from './renderStats';
import { Texture } from './texture';

/**
 * A depth-only framebuffer that renders into successive LAYERS of one `TEXTURE_2D_ARRAY`.
 * This is the cascaded shadow map target (and, for spot lights, the shadow atlas).
 *
 * Deliberately not part of `Framebuffer`: that class owns a fixed set of 2D attachments and
 * reallocates its textures on every `create()`, which is the opposite of what attaching successive
 * layers of one immutable `texStorage3D` volume needs — the storage is allocated exactly once and
 * only the ATTACHMENT changes per layer. The same call was made for `CubeFramebuffer` and for the
 * cloud noise volume bake in Renderer, for the same reason.
 */
export class LayeredDepthFramebuffer {
    private readonly _id: WebGL2Framebuffer;
    private _texture: Texture;
    private _size: number = 0;
    private _layers: number = 0;
    private _checked: boolean = false;

    constructor() {
        this._id = device.createFramebuffer('layeredDepthFramebuffer');
        this._texture = new Texture({ usage: 'depth', target: 'texture2DArray', mipMap: false });
    }

    /**
     * (Re)allocate the array at `size` x `size` x `layers`. Immutable storage cannot be resized, so a
     * change in either dimension throws the whole texture away and builds a new one — which is why the
     * resolution and cascade-count setters share this one path in the renderer.
     */
    public create(size: number, layers: number, compare: boolean = true): void {
        if (this._size === size && this._layers === layers && this._texture.width === size) return;
        this._texture.delete();
        this._texture = new Texture({ usage: 'depth', target: 'texture2DArray', mipMap: false });
        this._texture.createArrayTarget(size, layers, compare);
        this._size = size;
        this._layers = layers;
        this._checked = false;
    }

    /** Bind `layer` as the depth attachment and set the viewport to the map's resolution. */
    public bindLayer(layer: number): void {
        this._id.bind();
        this._id.attachDepthLayer(this._texture.texture, layer);
        // Depth-only: with no colour attachment, both draw and read buffers must be explicitly NONE
        // or the framebuffer is incomplete. setDrawBuffers(0) does the pair.
        this._id.setDrawBuffers(0);

        if (!this._checked) {
            this._checked = true;
            this._id.checkStatus('bindLayer');
        }

        gl.viewport(0, 0, this._size, this._size);
        setViewportSize(this._size, this._size);
    }

    public unbind(): void {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        setViewportSize(gl.canvas.width, gl.canvas.height);
    }

    /**
     * Reset every layer to depth 1.0, so every shadow lookup passes and nothing is occluded.
     * Used when a scene has no shadow-casting light: the depth pass is skipped entirely, and without
     * this the layers keep whatever the previously rendered scene left in them — which is how a
     * thumbnail or preview render inherits the shadows of the scene before it.
     */
    public clearAll(): void {
        gl.clearDepth(1.0);
        GLState.depthMask(true);
        for (let i = 0; i < this._layers; i++) {
            this.bindLayer(i);
            gl.clear(gl.DEPTH_BUFFER_BIT);
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
        this._id.destroy();
    }

    public get texture(): Texture { return this._texture; }
    public get size(): number { return this._size; }
    public get layers(): number { return this._layers; }
}
