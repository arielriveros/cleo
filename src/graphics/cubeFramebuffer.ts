import { gl } from './renderer';
import { Texture } from './texture';

/**
 * A framebuffer used to render into individual cube-map faces (and mip levels) of a cubemap
 * render target. Used by the IBL pipeline: capturing the scene into a cubemap, and the irradiance
 * / prefilter convolution passes. A single depth renderbuffer is (re)allocated on demand for the
 * passes that need depth testing (scene capture); the convolution passes are color-only.
 */
export class CubeFramebuffer {
    private _id: WebGLFramebuffer;
    private _rbo: WebGLRenderbuffer;
    private _depthSize: number = 0;

    constructor() {
        this._id = gl.createFramebuffer() as WebGLFramebuffer;
        this._rbo = gl.createRenderbuffer() as WebGLRenderbuffer;
    }

    /**
     * Bind a cube face (and mip level) of `cube` as color attachment 0.
     * @param withDepth allocate/attach a depth renderbuffer sized to `size` (needed for scene capture).
     * @param size face size at this mip (only required when withDepth is true).
     */
    public bindFace(cube: Texture, face: number, mip: number = 0, withDepth: boolean = false, size: number = 0): void {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._id);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, cube.texture, mip);

        if (withDepth) {
            if (this._depthSize !== size) {
                this._depthSize = size;
                gl.bindRenderbuffer(gl.RENDERBUFFER, this._rbo);
                gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, size, size);
                gl.bindRenderbuffer(gl.RENDERBUFFER, null);
            }
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this._rbo);
        } else {
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
        }

        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    }

    public unbind(): void {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    public get framebuffer(): WebGLFramebuffer { return this._id; }
}
