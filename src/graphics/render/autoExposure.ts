import { blendExposure, effectiveCurveStops } from '../exposureBlend';
import type { EffectiveExposure, ExposureLayer } from '../exposureBlend';
import { Framebuffer } from '../framebuffer';
import { REFERENCE_ILLUMINANCE } from '../lighting';
import type { ExposureCurveKey } from '../lighting';
import { device } from '../rhi/deviceHandle';
import { ExposureMeterProgram } from './programs';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { FullscreenPasses } from './fullscreenPasses';
import type { RenderSubsystems } from './subsystems';

/** What AutoExposure reads from the renderer that owns it: its own state, not another subsystem's. */
export interface AutoExposureHost {
    readonly ev100: number;
}

/**
 * Which exposure the frame renders at: the authored one, a fixed preview exposure, or the metered and
 * adapted one, with exposure volumes around the camera blended over the scene's settings. Owns the
 * 1x1 metering targets, the frame-late readback and the frame-rate-independent adaptation. Writes
 * the result into `FrameView.exposure`. Split out of Renderer.
 */
export class AutoExposure {
    constructor(private readonly _host: AutoExposureHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _fullscreen: FullscreenPasses,
                private readonly _sys: RenderSubsystems) {}

    /**
     * The AUTHORED exposure — what the artist set, what a scene saves, and what a preview renders at.
     *
     * Separate from `_view.exposure` because the meter overwrites that one continuously. Without the split,
     * `getRenderSettings()` saved whatever the meter happened to be at the instant of the save, and
     * suppressing metering for a preview would leave the preview sitting on the last adapted value —
     * so two thumbnails captured a second apart came out at different brightnesses.
     *
     * Written by the `exposure` / `ev100` setters and by `applyRenderSettings`. NEVER by the meter.
     */
    public baseExposure: number = 2.0;

    /**
     * Whether this host currently permits metering at all — distinct from {@link
     * RenderSettings.autoExposureEnabled}, which is the project's setting and rides `config.render`.
     *
     * The editor suppresses metering on every tab that is not the scene: those render a throwaway
     * preview with `createMaterialPreviewScene`'s fixed studio rig, which has nothing to do with the
     * project, so an exposure metered from it means nothing. Toggling the SETTING per tab instead would
     * either fight the saved value or mark the scene dirty on a tab switch.
     *
     * Defaults to allowed, so the standalone player and any non-editor host meter with no extra call.
     * Deliberately not part of `RenderSettings` — it is view state, like `debugView`.
     */
    public exposureMeteringAllowed: boolean = true;

    // --- auto-exposure ------------------------------------------------------------------------
    public autoExposureEnabled: boolean = true;

    // +1 stop, which is Unreal's `AutoExposureBias` default. Metering to middle grey alone lands a
    // scene about a stop under where a hand-set exposure usually sits — measured on the harness scene,
    // frame mean 202 to 146 — because 0.18 is a reflectance target and most content is not an 18% grey
    // card. Every engine that ships auto-exposure ships a positive bias on top of it for that reason.
    public exposureCompensation: number = 1.0;
    public exposureCompensationCurve: ExposureCurveKey[] = [];
    public exposureMinEV: number = 2.0;
    public exposureMaxEV: number = 17.0;
    public exposureSpeedUp: number = 3.0;
    public exposureSpeedDown: number = 1.0;

    /**
     * The exposure settings IN FORCE this frame: the scene's fields above, with any exposure volumes
     * around the camera blended over them (`resolveExposure`). The meter, the clamp and the adaptation
     * read this; the getters, setters and `getRenderSettings` stay on the scene's own fields, so a volume
     * never reaches a saved scene.
     */
    public get effExposure(): EffectiveExposure {
        // Rebuilt on every read (a handful a frame) rather than cached, so a setter or
        // `applyRenderSettings` between frames is in force at once, as it was before volumes.
        return this._sceneExposureOnly(this._effExposureLayers);
    }

    /** The volumes around the camera at the last `resolveExposure`, as blend layers. */
    private _effExposureLayers: ExposureLayer[] = [];

    /** The same volumes, by id and weight, for the inspector. */
    public effExposureVolumes: { id: string, weight: number }[] = [];

    /** Whether metering was in force at the last `resolveExposure`, to catch a volume switching it on. */
    private _effAutoWas: boolean = true;

    /** A volume around the camera sets the manual EV; otherwise the authored `baseExposure` stands exactly. */
    private _effManualFromVolume: boolean = false;

    /** Two 1x1 metering targets. See `exposurePass` for why they are read a frame late. */
    public exposureFBOs: Framebuffer[] = [];
    private _exposureWrite: number = 0;

    /** True once a readback has landed; until then the hand-set exposure stands. */
    public exposureMetered: boolean = false;
    private _exposureReadPending: boolean = false;

    /** Which metering target the end of the frame should read, or -1 for none. */
    private _exposureReadDue: number = -1;

    /**
     * Frames between readbacks. Metering runs every frame — it is 256 fetches into one fragment — but
     * the READ is the expensive half: `readPixels` is synchronous under the hood on WebGL2, so every
     * one of them drains the pipeline. Six is 10Hz at 60fps, against an adaptation half-life measured
     * in seconds.
     */
    private static readonly EXPOSURE_READ_INTERVAL = 6;

    /** The adapted value, in EV100. Seeded from the initial exposure so frame one does not jump. */
    public exposureEV: number = 0;

    /** Must match LOG_LUM_MIN/MAX in exposureMeter.wgsl. */
    private static readonly LOG_LUMINANCE_WINDOW: [number, number] = [-22.0, 8.0];

    /**
     * Where the metered average is placed. 0.18 is middle grey — the reflectance a light meter assumes
     * and the value every photographic exposure system is calibrated around.
     */
    private static readonly EXPOSURE_KEY = 0.18;

    /**
     * Meter the lit scene into a 1x1 target, and adapt `_view.exposure` toward what LAST frame measured.
     *
     * A FRAME LATE, deliberately. Reading a target the GPU finished with a frame ago costs nothing;
     * reading the one just written forces the pipeline to drain, and `readPixels` is synchronous under
     * the hood on WebGL2. One frame of lag is invisible against an adaptation half-life measured in
     * seconds — the smoothing below would swallow far more than that.
     *
     * `_targets.scene`, not the compose buffer: metering has to happen on the lit scene before bloom adds
     * light back into it, or exposure and bloom chase each other — bloom brightens the frame, the meter
     * darkens the exposure, which changes bloom's display-referred threshold, and so on.
     */
    public exposurePass(dtSeconds: number): void {
        // No gate and no scope of its own: the node is added only when metering is live and the pass is
        // switched on (see `_buildPostGraph`), and the graph opens the scope for every node it runs.
        const write = this._exposureWrite;
        const read = 1 - write;
        const pass = this._passes.beginFullscreenPass(this.exposureFBOs[write].renderTarget, 'exposure', true,
                                               undefined, false);
        this._fullscreen.bind(pass, 'exposureMeter', ExposureMeterProgram, [this._targets.scene.colors[0]]);
        this._passes.drawFullscreenAndEnd(pass);
        this._exposureWrite = read;

        // The READ does not happen here. `readPixels` binds a scratch framebuffer of its own and
        // unbinds to the default one when it is done, so calling it between two passes leaves the
        // chain that follows drawing somewhere else — measured, and it cost the WebGL2 context
        // outright (error 37442, CONTEXT_LOST_WEBGL, raised at the next frame's prologue). It is
        // deferred to `readExposureSample`, after the frame is finished.
        this._exposureReadDue = read;
        this._adaptExposure(dtSeconds);
    }

    /** Is metering driving the exposure this frame? The project's setting AND this host's permission. */
    public meteringActive(): boolean {
        return this.effExposure.autoExposureEnabled && this.exposureMeteringAllowed;
    }

    /** The scene's own exposure settings, with no volume over them. */
    private _sceneExposureOnly(layers: readonly ExposureLayer[] = []): EffectiveExposure {
        return blendExposure({
            autoExposureEnabled: this.autoExposureEnabled,
            ev100: Math.log2(REFERENCE_ILLUMINANCE / (1.2 * Math.max(1e-6, this.baseExposure))),
            exposureCompensation: this.exposureCompensation,
            exposureCompensationCurve: this.exposureCompensationCurve,
            exposureMinEV: this.exposureMinEV,
            exposureMaxEV: this.exposureMaxEV,
            exposureSpeedUp: this.exposureSpeedUp,
            exposureSpeedDown: this.exposureSpeedDown,
        }, layers);
    }

    /**
     * Blend the exposure volumes around the camera over the scene's settings, into `effExposure`.
     * A volume that switches metering on re-seeds the adaptation from the current picture, as the
     * `autoExposureEnabled` setter does, so walking into it eases instead of snapping.
     */
    private _updateEffectiveExposure(): void {
        const scene = this._view.scene;
        const camera = this._view.camera;
        const found = scene && camera ? scene.exposureVolumesAt(camera.position) : [];
        this._effExposureLayers = found.map(f => ({ overrides: f.volume.overridesView, weight: f.weight }));
        this.effExposureVolumes = found.map(f => ({ id: f.volume.id, weight: f.weight }));
        this._effManualFromVolume = found.some(f => f.volume.overridesView.ev100 !== undefined);
        const auto = this.effExposure.autoExposureEnabled;
        if (auto && !this._effAutoWas) {
            this.exposureEV = this._host.ev100;
            this.exposureMetered = false;
        }
        this._effAutoWas = auto;
    }

    /**
     * Decide which exposure is in force before anything reads it.
     *
     * Called at the TOP of `_applyPostProcessing`, above the thumbnail early-return, and that placement
     * is the point: `screenshotOffscreen` sets `Capture.presentTarget`, which returns before the metering pass
     * ever runs — so a thumbnail never meters, but without this it would still render at whatever the
     * last live frame had adapted to. Two thumbnails captured a second apart came out at different
     * brightnesses, and the whole asset library shifted whenever the scene's exposure moved.
     */
    public resolveExposure(): void {
        // A PREVIEW renders at a fixed exposure, not the project's. The preview scenes carry their own
        // studio rig, so the exposure that renders them correctly is a constant — and pinning it is what
        // keeps every thumbnail in the asset library comparable with the others and stable as the scene
        // is retuned. Using the project's authored value instead looks reasonable and is not: a scene
        // saved while auto-exposure had opened up on a dim interior banks a very large exposure, and
        // every preview in the editor then renders blown out.
        //
        // `Capture.presentTarget` counts as a preview whichever tab it was taken from: that is the offscreen
        // thumbnail path, and a thumbnail keyed to the scene's momentary exposure is the inconsistency
        // this whole split exists to remove.
        if (!this.exposureMeteringAllowed || this._sys.capture.presentTarget) {
            this._view.exposure = AutoExposure.PREVIEW_EXPOSURE;
            return;
        }
        this._updateEffectiveExposure();
        // Metering allowed but switched off (for the project, or by a volume around the camera): the
        // manual exposure stands — the artist's, blended toward any volume's in EV.
        if (!this._effAutoWas) {
            this._view.exposure = this._effManualFromVolume
                ? REFERENCE_ILLUMINANCE / (1.2 * Math.pow(2, this.effExposure.ev100))
                : this.baseExposure;
        }
    }

    /**
     * The exposure every preview and thumbnail renders at: EV100 15, the engine default, and the value
     * the preview scenes were authored against long before auto-exposure existed. Deliberately a
     * constant rather than the project's setting — see `resolveExposure`.
     */
    private static readonly PREVIEW_EXPOSURE = 2.0;

    /**
     * Pull the metering result back, at the very end of the frame and only every few frames.
     *
     * `readPixels` binds and then UNBINDS a framebuffer, so between passes it would redirect everything
     * after it; here there is no pass left to disturb. The result arrives a frame or two later on both
     * backends (WebGPU maps a copy; WebGL2 copies into a pixel-pack buffer and waits on a fence), and
     * one read is in flight at a time — the adaptation eases toward the target anyway.
     */
    public readExposureSample(): void {
        const due = this._exposureReadDue;
        this._exposureReadDue = -1;
        if (due < 0 || this._exposureReadPending) return;
        if (this.exposureMetered && this._view.frameIndex % AutoExposure.EXPOSURE_READ_INTERVAL !== 0) return;
        const target = this.exposureFBOs[due];
        if (!target || target.colors.length === 0) return;

        this._exposureReadPending = true;
        device.readPixels(target.colors[0].attachmentView, 0, 0, 1, 1)
            .then(px => { this._onExposureSample((px[0] + px[1] / 255) / 255); })
            .catch(() => { /* a resize can invalidate the view mid-flight; the next read recovers */ })
            .finally(() => { this._exposureReadPending = false; });
    }

    /** Decode one metering sample into the target EV100 the adaptation is chasing. */
    private _onExposureSample(encoded: number): void {
        const [lo, hi] = AutoExposure.LOG_LUMINANCE_WINDOW;
        const avgLuminance = Math.pow(2, lo + encoded * (hi - lo));
        // Place the metered average at middle grey, then read that exposure back as an EV100 so the
        // clamps and the compensation below are in the unit the inspector already speaks.
        const wanted = AutoExposure.EXPOSURE_KEY / Math.max(avgLuminance, 1e-9);
        this._exposureTargetEV = Math.log2(REFERENCE_ILLUMINANCE / (1.2 * Math.max(1e-9, wanted)));
        if (!this.exposureMetered) {
            // First sample: snap rather than ease, or the opening second of every scene is a fade-in.
            this.exposureEV = this._clampExposureEV(this._exposureTargetEV);
            this.exposureMetered = true;
        }
    }

    private _exposureTargetEV: number = 0;
    public lastExposureMs: number = performance.now();

    private _clampExposureEV(ev: number): number {
        // Compensation is SUBTRACTED: +1 stop of exposure compensation means a brighter picture, which
        // on a meter is a LOWER EV. Applied after the clamp so the trim can still reach past it. The
        // curve is keyed on the UNCLAMPED metered EV, the scene's own brightness, as Unreal keys it.
        // Reads the settings in force, so an exposure volume around the camera clamps and trims too.
        const e = this.effExposure;
        const lo = Math.min(e.exposureMinEV, e.exposureMaxEV);
        const hi = Math.max(e.exposureMinEV, e.exposureMaxEV);
        return Math.min(hi, Math.max(lo, ev)) - e.exposureCompensation - effectiveCurveStops(e, ev);
    }

    /**
     * Ease `_view.exposure` toward the metered target, in EV (log) space, at a rate that does not depend on
     * the frame rate.
     *
     * `1 - exp(-dt * speed)` rather than a fixed `dt * k` per frame: the naive form adapts twice as fast
     * at 120fps as at 60, so a scene's look would depend on the machine it ran on.
     *
     * A RATE, not a duration — `* speed`, not `/ speed`. This was the other way round when it landed,
     * which made the settings a time constant in seconds while carrying Unreal's rate NAMES and Unreal's
     * rate VALUES. The digits matched and the meaning did not: at 3.0 it was a three-second constant
     * where Unreal's is a third of a second, so adaptation ran nine times slower than the numbers
     * implied, and a slider labelled speed would have moved the wrong way.
     */
    private _adaptExposure(dtSeconds: number): void {
        if (!this.exposureMetered) return;
        const target = this._clampExposureEV(this._exposureTargetEV);
        // Brightening the PICTURE means the EV falls, and that is the direction an eye is slow in.
        const speed = target < this.exposureEV ? this.effExposure.exposureSpeedDown : this.effExposure.exposureSpeedUp;
        // 0 snaps rather than freezing. A rate of zero would literally never converge, which is useless
        // as the bottom of a slider and is also what `passConfigs.js` relies on to gate this
        // deterministically.
        const t = speed <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dtSeconds) * speed);
        this.exposureEV += (target - this.exposureEV) * t;
        this._view.exposure = REFERENCE_ILLUMINANCE / (1.2 * Math.pow(2, this.exposureEV));
    }
}
