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
    /**
     * Scratch depth, one per face size, kept for the life of the framebuffer. It used to be ONE texture
     * reallocated whenever the size changed, and deleting it mid-frame is what broke WebGPU: two light
     * probes of different resolutions captured in the same frame — every probe bakes at the start of
     * Play — left the first capture's passes pointing at a destroyed texture, the queue rejected the
     * frame's whole command buffer, and the sky bake recorded in it with them: a black sky.
     */
    private readonly _depths = new Map<number, Texture>();

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

    // Made on first use of each size and never released before `destroy`: a frame may already have
    // recorded passes against it. Probe resolutions are a handful of powers of two.
    private _depthFor(size: number): Texture {
        let depth = this._depths.get(size);
        if (!depth) {
            depth = new Texture({ usage: 'depth', mipMap: false });
            depth.create(null, size, size);
            this._depths.set(size, depth);
        }
        return depth;
    }

    /** Release the scratch depth textures. The cube faces belong to the cubemap, not to this. */
    public destroy(): void {
        for (const depth of this._depths.values()) depth.delete();
        this._depths.clear();
    }
}
