import { glDevice } from './rhi/webgl2/webgl2Device';
import { device } from './rhi/deviceHandle';
import type { RenderTarget } from './rhi/resources';
import type { WebGL2RenderTarget } from './rhi/webgl2/webgl2Commands';
import { Texture } from './texture';

/**
 * Renders into individual cube-map faces (and mip levels) of a cubemap render target. Used by the IBL
 * pipeline: capturing the scene into a cubemap, and the irradiance / prefilter convolution passes.
 *
 * There is nothing left here that a plain {@link Framebuffer} does differently — a face at a mip level
 * is just a `TextureView` with a `baseArrayLayer` and a `baseMipLevel`, and the device keeps one render
 * target per distinct view set. What survives as a class is the one thing that is genuinely this
 * pipeline's own: a scratch DEPTH attachment that only the scene-capture pass wants, sized to whichever
 * face size it is capturing at, while the convolution passes are colour-only.
 *
 * That depth attachment used to be a `WebGLRenderbuffer`, reallocated in place and attached or detached
 * per face. It is a depth TEXTURE now, because WebGPU has no renderbuffers at all and a depth texture is
 * what both backends can express — same DEPTH_COMPONENT24 storage, same result.
 */
export class CubeFramebuffer {
    private _depth: Texture | null = null;
    private _depthSize: number = 0;

    /**
     * Bind a cube face (and mip level) of `cube` as colour attachment 0.
     * @param withDepth attach a depth texture sized to `size` (needed for scene capture).
     * @param size face size at this mip (only required when withDepth is true).
     */
    /**
     * The render target for one face/mip, for a caller recording through the RHI rather than binding.
     *
     * Same cached target `bindFace` uses — the deduplication in `createRenderTarget` is what keeps a
     * six-face bake from stranding six framebuffers per mip level.
     */
    public targetFor(cube: Texture, face: number, mip: number = 0,
                     withDepth: boolean = false, size: number = 0): RenderTarget {
        return this._target(cube, face, mip, withDepth, size);
    }

    /**
     * The legacy bind model — see the note on `Framebuffer.bind`. `RenderTarget.bind()` is WebGL2-only
     * because binding a framebuffer object is not something WebGPU has, so the cast is the coupling
     * stated rather than the interface widened to hide it.
     */
    public bindFace(cube: Texture, face: number, mip: number = 0, withDepth: boolean = false, size: number = 0): void {
        (this._target(cube, face, mip, withDepth, size) as WebGL2RenderTarget).bind(false);
    }

    /** Hand the draw target back to the canvas. The viewport is the caller's — see bindFace. */
    public unbind(): void {
        glDevice().getCurrentSurfaceTarget().bind(false);
    }

    private _target(cube: Texture, face: number, mip: number, withDepth: boolean, size: number): RenderTarget {
        return device.createRenderTarget({
            label: 'cubeFramebuffer',
            colorViews: [device.createTextureView(cube.gpu, mip, face)],
            depthView: withDepth ? this._depthFor(size).view : undefined,
        });
    }

    /**
     * The scratch depth texture at `size`.
     *
     * Reallocated only when the size changes, which is what the renderbuffer did. Deleting the old one
     * also evicts every render target it was attached to, so the next capture builds a target over the
     * new storage rather than reusing a framebuffer pointing at freed memory.
     */
    private _depthFor(size: number): Texture {
        if (this._depth && this._depthSize === size) return this._depth;
        this._depth?.delete();
        this._depth = new Texture({ usage: 'depth', mipMap: false });
        this._depth.create(null, size, size);
        this._depthSize = size;
        return this._depth;
    }

    /** Release the scratch depth texture. The cube faces belong to the cubemap, not to this. */
    public destroy(): void {
        this._depth?.delete();
        this._depth = null;
        this._depthSize = 0;
    }
}
