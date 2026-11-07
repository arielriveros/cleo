import { Framebuffer } from '../framebuffer';
import type { Texture } from '../texture';
import { LocalExposureLumProgram, LocalExposureDownProgram } from './programs';
import { displayExposure } from './frameView';
import type { FrameView } from './frameView';
import type { PassEncoder } from './passEncoder';
import type { FullscreenPasses } from './fullscreenPasses';
import type { BindGroupCache } from './bindGroups';
import { ShaderManager } from '../systems/shaderManager';

/**
 * Local exposure: exposure fusion run as a pyramid of region weights (Mertens et al. 2007; Wronski,
 * "Exposure Fusion: local tonemapping for real-time rendering", 2022), applied in the display resolve.
 *
 * Why. One exposure can only show one brightness range. A torch pool at night sits five to seven stops over
 * the moonlit ground around it — more than any global exposure and tone curve can hold, so either the pool
 * clips or the field goes black. Local exposure lifts the regions a brighter exposure shows better and
 * holds back the ones a darker exposure shows better, smoothly and per REGION, so the detail inside each
 * keeps its own contrast. Unreal 5's Local Exposure and Ghost of Tsushima's bilateral grid do the same job;
 * fusion needs only downsamples and gathers, so it runs the same on WebGL2 and WebGPU.
 *
 * Passes: `localExposure` (quarter-resolution weights and guide, localExposureLum.wgsl), then halvings to
 * about 1/128 of the frame (localExposureDown.wgsl). The present reads the last level
 * (chunks/localExposure.wgsl).
 */
export class LocalExposurePasses {
    private readonly _shaderManager = ShaderManager.Instance;

    /** RenderSettings.localExposureEnabled. */
    public enabled = false;
    /** How many stops brighter the shadow exposure is: how far the darkest regions can be lifted. */
    public shadowStops = 1.5;
    /** How many stops darker the highlight exposure is: how far the brightest regions can be held back. */
    public highlightStops = 1.5;
    /** 0..1: how much of the fused shift is applied. */
    public strength = 0.6;

    /** Quarter resolution first, then halvings. Enough levels to describe regions, not pixels. */
    private static readonly LEVELS = 5;

    private readonly _levels: Framebuffer[] = [];

    /** Whether this frame's levels were built: the present reads them only then. */
    public producedThisFrame = false;

    constructor(private readonly _view: FrameView,
                private readonly _passes: PassEncoder,
                private readonly _fullscreen: FullscreenPasses,
                private readonly _bindGroups: BindGroupCache) {}

    /** The coarse level the present samples, or the fallback when nothing was built this frame. */
    public get texture(): Texture {
        const last = this._levels[this._levels.length - 1];
        return this.producedThisFrame && last ? last.colors[0] : this._bindGroups.fallbackTexture;
    }

    /** The present's `u_localExposure` (strength, shadow stops, highlight stops, guide sharpness). */
    public params(): [number, number, number, number] {
        if (!this.producedThisFrame) return [0, 0, 0, 0];
        // Sharpness of the guide: regions within about a stop of a pixel's luminance count fully.
        return [Math.min(1, Math.max(0, this.strength)), Math.max(0, this.shadowStops), Math.max(0, this.highlightStops), 0.5];
    }

    /** Mark the frame's levels stale. Called at the top of the post chain. */
    public beginFrame(): void { this.producedThisFrame = false; }

    /** Build the levels from the chain's final HDR image (`source`), `width` x `height` render pixels. */
    public generate(source: Framebuffer, width: number, height: number): void {
        this._ensure(width, height);
        const first = this._levels[0];
        const pass = this._passes.beginFullscreenPass(first.renderTarget, 'localExposure', true, undefined, false);
        this._fullscreen.bind(pass, 'localExposureLum', LocalExposureLumProgram, [source.colors[0]]);
        this._shaderManager.setUniform('u_srcTexelSize', [1 / Math.max(1, width), 1 / Math.max(1, height)]);
        this._shaderManager.setUniform('u_dstResolution', [first.width, first.height]);
        this._shaderManager.setUniform('u_exposure', displayExposure(this._view));
        this._shaderManager.setUniform('u_shadowStops', Math.max(0, this.shadowStops));
        this._shaderManager.setUniform('u_highlightStops', Math.max(0, this.highlightStops));
        this._passes.drawFullscreenAndEnd(pass);

        for (let i = 1; i < this._levels.length; i++) {
            const from = this._levels[i - 1], to = this._levels[i];
            const down = this._passes.beginFullscreenPass(to.renderTarget, 'localExposure', false, undefined, false);
            this._fullscreen.bind(down, 'localExposureDown', LocalExposureDownProgram, [from.colors[0]]);
            this._shaderManager.setUniform('u_srcTexelSize', [1 / from.width, 1 / from.height]);
            this._shaderManager.setUniform('u_dstResolution', [to.width, to.height]);
            this._passes.drawFullscreenAndEnd(down);
        }
        this.producedThisFrame = true;
    }

    /** Every level's target, for memory accounting. */
    public get targets(): readonly Framebuffer[] { return this._levels; }

    private _ensure(width: number, height: number): void {
        while (this._levels.length < LocalExposurePasses.LEVELS)
            this._levels.push(new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false }));
        let w = Math.max(1, Math.floor(width / 4));
        let h = Math.max(1, Math.floor(height / 4));
        for (const level of this._levels) {
            if (level.width !== w || level.height !== h) level.create(w, h);
            w = Math.max(1, Math.floor(w / 2));
            h = Math.max(1, Math.floor(h / 2));
        }
    }
}
