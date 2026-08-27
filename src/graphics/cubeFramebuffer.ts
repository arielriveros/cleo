import { glDevice } from './rhi/webgl2/webgl2Device';
import { device } from './rhi/deviceHandle';
import type { RenderTarget } from './rhi/resources';
import type { WebGL2RenderTarget } from './rhi/webgl2/webgl2Commands';
import { Texture } from './texture';

/**
 * Renders into individual cube-map faces and mip levels of a cubemap target, with an optional scratch
 * depth attachment. Used by the IBL pipeline for scene capture and the convolution passes.
 */
export class CubeFramebuffer {
    private _depth: Texture | null = null;
    private _depthSize: number = 0;

    /**
     * The render target for one face/mip of `cube`, for callers recording through the RHI.
     * @param withDepth attach a depth texture of `size` (needed for scene capture).
     */
    public targetFor(cube: Texture, face: number, mip: number = 0,
                     withDepth: boolean = false, size: number = 0): RenderTarget {
        return this._target(cube, face, mip, withDepth, size);
    }

    /** Bind a cube face/mip as colour attachment 0. WebGL2 only; a no-op on other backends. */
    public bindFace(cube: Texture, face: number, mip: number = 0, withDepth: boolean = false, size: number = 0): void {
        if (device.backend !== 'webgl2') return;
        (this._target(cube, face, mip, withDepth, size) as WebGL2RenderTarget).bind(false);
    }

    /** Hand the draw target back to the canvas. The viewport is the caller's. */
    public unbind(): void {
        if (device.backend !== 'webgl2') return;

        glDevice().getCurrentSurfaceTarget().bind(false);
    }

    private _target(cube: Texture, face: number, mip: number, withDepth: boolean, size: number): RenderTarget {
        return device.createRenderTarget({
            label: 'cubeFramebuffer',
            colorViews: [device.createTextureView(cube.rhiTexture, mip, face)],
            depthView: withDepth ? this._depthFor(size).attachmentView : undefined,
        });
    }

    // Reallocated only on a size change; deleting the old texture also evicts every render target
    // that referenced it.
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
