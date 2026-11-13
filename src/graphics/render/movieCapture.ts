import { Framebuffer } from '../framebuffer';
import { device } from '../rhi/deviceHandle';
import type { RenderTarget } from '../rhi/resources';
import { ShaderManager } from '../systems/shaderManager';
import { MovieAccumulateProgram } from './programs';
import type { FrameView } from './frameView';
import type { PassEncoder } from './passEncoder';
import type { FullscreenPasses } from './fullscreenPasses';

/** What MovieCapture reads from the renderer that owns it. */
export interface MovieCaptureHost {
    /** Bumped by every temporal invalidation, a camera cut among them. */
    readonly cutEpoch: number;
    /** The display resolve, into `target`. */
    present(source: Framebuffer, target: RenderTarget): void;
}

/**
 * A movie's frames (src/sequencer/movie/): the renderer drawing at the movie's size into a target of its own
 * instead of the canvas, and averaging each frame's samples before the display resolve.
 *
 * A frame is `samples` renders. Each one is jittered by its own sub-pixel offset and, with a shutter, taken
 * at its own moment, and each lands in a running mean ({@link present}) in linear HDR, pre-exposure
 * corrected between samples. The last one resolves the mean — exposure, tone curve, grade, dither, once —
 * into the 8-bit {@link target} the movie reads back. One sample resolves straight through, the way the
 * canvas would. The result is anti-aliased by the jitter and motion-blurred by the shutter, both the way a
 * camera does it: by integrating light, not by filtering a finished picture.
 *
 * A camera cut inside a frame's shutter restarts its mean at the cut, so two shots never blend.
 */
export class MovieCapture {
    private readonly _shaderManager = ShaderManager.Instance;

    private _active = false;
    private _width = 0;
    private _height = 0;

    /** The frame's sample count, and which sample the next render is (0-based). Set per render. */
    public samples = 1;
    public sample = 0;

    /** The resolved frame: RGBA8, the movie's size. */
    private _target: Framebuffer | null = null;
    /** The running mean, ping-ponged: HDR, never mip-mapped, no depth. */
    private readonly _mean: Framebuffer[] = [];
    private _read = 0;
    /** The pre-exposure the mean is stored at (FrameView.preExposure). */
    private _meanExposure = 1;
    /** The sample the mean (re)started at: 0, or the first after a cut. */
    private _meanStart = 0;
    private _epoch = 0;

    /** True once the last render resolved a finished frame into {@link target}. */
    public framePresented = false;

    constructor(private readonly _host: MovieCaptureHost,
                private readonly _view: FrameView,
                private readonly _passes: PassEncoder,
                private readonly _fullscreen: FullscreenPasses) {}

    public get active(): boolean { return this._active; }
    public get width(): number { return this._width; }
    public get height(): number { return this._height; }

    /** Allocate the movie's targets at `width` x `height`. */
    public begin(width: number, height: number): void {
        this._width = Math.max(1, Math.round(width));
        this._height = Math.max(1, Math.round(height));
        // 8-bit, NOT `precision: 'high'` — WebGL2's readPixels(RGBA, UNSIGNED_BYTE) needs an 8-bit target.
        this._target = new Framebuffer({ colorTextureOptions: { mipMap: false }, depth: false });
        this._target.create(this._width, this._height);
        for (let i = 0; i < 2; i++) {
            const fbo = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false });
            fbo.create(this._width, this._height);
            this._mean.push(fbo);
        }
        this._read = 0;
        this._active = true;
        this.samples = 1;
        this.sample = 0;
        this.framePresented = false;
    }

    /** Release everything {@link begin} allocated. */
    public end(): void {
        this._active = false;
        this._target?.destroy();
        this._target = null;
        for (const fbo of this._mean) fbo.destroy();
        this._mean.length = 0;
        this.framePresented = false;
    }

    /**
     * The post graph's display resolve, in a movie: fold `result` (the chain's final linear-HDR image) into
     * the frame's mean, and resolve the mean into {@link target} on the frame's last sample.
     */
    public present(result: Framebuffer): void {
        this.framePresented = false;
        if (!this._target) return;
        const last = this.sample >= this.samples - 1;
        if (this.samples <= 1) {
            this._host.present(result, this._target.renderTarget);
            this.framePresented = true;
            return;
        }
        const epoch = this._host.cutEpoch;
        if (this.sample === 0 || epoch !== this._epoch) this._meanStart = this.sample;
        this._epoch = epoch;

        const pre = this._view.preExposure > 0 ? this._view.preExposure : 1;
        const weight = 1 / (this.sample - this._meanStart + 1);
        const previous = this._mean[this._read];
        const next = this._mean[this._read ^ 1];
        const pass = this._passes.beginFullscreenPass(next.renderTarget, 'movieAccumulate', false);
        this._fullscreen.bind(pass, 'movieAccumulate', MovieAccumulateProgram, [result.colors[0], previous.colors[0]]);
        this._shaderManager.setUniform('u_params', [weight, pre / this._meanExposure, 0, 0]);
        this._passes.drawFullscreenAndEnd(pass);
        this._read ^= 1;
        this._meanExposure = pre;

        if (!last) return;
        this._host.present(this._mean[this._read], this._target.renderTarget);
        this.framePresented = true;
    }

    /**
     * The resolved frame as tightly packed RGBA bytes, the TOP row first. Call after the render that
     * presented it. Read at the call, waiting there: a movie has nothing else to do meanwhile, and a hidden
     * window's timers must not pace it.
     */
    public async readFrame(): Promise<Uint8Array> {
        const target = this._target;
        if (!target) throw new Error('No movie frame to read: the renderer is not in a movie');
        const w = this._width, h = this._height;
        const pixels = await device.readPixels(target.colors[0].attachmentView, 0, 0, w, h, { immediate: true });
        // A resampled scene buffer, like the thumbnail present: every pass into it is a screen-quad blit of
        // the scene, so its rows are the scene's and the backend's readback rule applies.
        if (device.capabilities.conventions.readbackRowsTopDown) return pixels;
        const row = w * 4;
        const flipped = new Uint8Array(pixels.length);
        for (let y = 0; y < h; y++) flipped.set(pixels.subarray((h - 1 - y) * row, (h - y) * row), y * row);
        return flipped;
    }
}
