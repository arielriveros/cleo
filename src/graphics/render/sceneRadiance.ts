import { mat4 } from 'gl-matrix';
import { Framebuffer } from '../framebuffer';
import { SsilHistoryProgram } from './programs';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { ViewProjection } from './viewProjection';
import type { TemporalPasses } from './temporal';
import type { FullscreenPasses } from './fullscreenPasses';
import { ShaderManager } from '../systems/shaderManager';

/** What SceneRadianceCopy reads from the renderer that owns it. */
export interface SceneRadianceHost {
    readonly jitteredCameraProj: mat4;
    readonly renderHeight: number;
    readonly renderWidth: number;
    readonly thumbnailMode: boolean;
    /**
     * The resolution the copy is wanted at this frame, as a fraction of the render size: the largest
     * any consumer asks for, or 0 when none is switched on (and the copy is then not taken at all).
     */
    readonly radianceScale: number;
}

/**
 * Last frame's lit opaque image, reduced, with the view depth each texel was seen at (ssilHistory.wgsl):
 * the light that screen-space indirect lighting bounces and that screen-space reflections reflect. Both
 * read it reprojected through last frame's camera, and both use the depth beside it to tell a surface
 * they still see from one that has since been uncovered.
 *
 * One copy for every consumer, at the largest resolution any of them asks for. SSIL and SSR both sample
 * it by uv, never by texel, so a copy larger than either one's own target serves both.
 */
export class SceneRadianceCopy {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: SceneRadianceHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _projection: ViewProjection,
                private readonly _temporal: TemporalPasses,
                private readonly _fullscreen: FullscreenPasses) {}

    /** rgb = linear HDR radiance (pre-exposure), a = view depth (60000 = no surface). Lazily allocated. */
    public fbo: Framebuffer | null = null;

    /**
     * `_view.frameIndex` the copy was last written in; -1 = never, or reallocated since. A STAMP rather
     * than a valid flag — see `SsilPasses.ssilHistoryFrame` for why a flag would lie.
     */
    public frame: number = -1;

    /**
     * Cleared when the copy came back rgba8unorm on a device without float render targets: 8 bits clip
     * every highlight at 1 and have no room for a depth, so nothing may reflect or bounce it.
     */
    public supported: boolean = true;

    private _width = 0;
    private _height = 0;
    private readonly _invProjection: mat4 = mat4.create();

    /** The size the host currently asks for, in texels. */
    private _size(): [number, number] {
        const scale = this._host.radianceScale;
        return [Math.max(1, Math.round(this._host.renderWidth * scale)),
                Math.max(1, Math.round(this._host.renderHeight * scale))];
    }

    /**
     * Allocate the copy and size it to what the host asks for now. A reallocation drops the stamp:
     * `Framebuffer.resize` hands back uninitialized memory, not a stale image.
     */
    public ensure(): Framebuffer {
        if (!this.fbo)
            this.fbo = new Framebuffer({ colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false });
        const [w, h] = this._size();
        if (w !== this._width || h !== this._height) {
            this.fbo.resize(w, h);
            this._width = w;
            this._height = h;
            this.frame = -1;
            this.supported = !this.fbo.colors[0].downgraded;
        }
        return this.fbo;
    }

    /** Whether the copy holds LAST frame's image — the only age a reprojecting pass can use. */
    public get fresh(): boolean {
        return this.supported && this.fbo !== null && this.frame >= 0
            && this.frame === this._view.frameIndex - 1 && this._view.hasPrevViewProj;
    }

    /** Stop trusting the copy (a cut, a resize); the next capture starts it over. */
    public invalidate(): void { this.frame = -1; }

    /**
     * Keep this frame's lit opaque image for NEXT frame's consumers. At the temporal boundary on purpose:
     * the scene is final there (TAA-resolved when TAA ran) and nothing that must not be bounced or
     * reflected — transparents, particles, sprites, editor chrome — has been drawn yet.
     *
     * Its label is still `ssao.history`, the profiler scope it had when SSIL was its only reader.
     */
    public capture(): void {
        // Not from a preview pane: its stamp would hand the editing view another camera's light as fresh.
        if (this._host.radianceScale <= 0 || this._host.thumbnailMode || this._view.preview) return;
        const target = this.ensure();
        if (!this.supported) return;
        if (!this._passes.beginPass('ssao.history')) return;
        const pass = this._passes.beginFullscreenPass(target.renderTarget, 'ssao.history', true, undefined, false);
        this._fullscreen.bind(pass, 'ssilHistory', SsilHistoryProgram, [
            this._targets.scene.colors[0], this._temporal.depthSource(),
        ]);
        // The depth snapshot was rasterized through this frame's jittered projection.
        mat4.invert(this._invProjection, this._host.jitteredCameraProj);
        this._projection.uvConsuming(this._invProjection, this._invProjection);
        this._shaderManager.setUniform('u_invProjection', this._invProjection);
        this._passes.drawFullscreenAndEnd(pass);
        this.frame = this._view.frameIndex;
        this.preExposure = this._view.preExposure;
    }

    /** The pre-exposure the copy was taken at: its readers bring it to theirs (`rescale`). */
    public preExposure = 1;

    /** What the copy's colour must be multiplied by to be in a frame pre-exposed by `k`. */
    public rescale(k: number): number { return (k > 0 ? k : 1) / (this.preExposure > 0 ? this.preExposure : 1); }
}
