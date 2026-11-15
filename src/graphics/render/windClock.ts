import type { Scene } from '../../core/scene/scene';
import { WindFieldSnapshot, windFieldClock, advanceGustTravel } from '../../core/wind/windField';
import type { FrameView } from './frameView';
import { renderNow, renderClockOverridden } from './renderClock';

/**
 * The renderer's effects clock and the frame's wind: `windTime`/`windDelta` on the FrameView, which the foliage, the
 * clouds, the fog, light flicker, water ripples, custom materials' `u_time`, the precipitation and the particles all
 * read, and the scene's wind field captured once per frame. Core: every game has it, whichever optional features it
 * was built with (the foliage that once owned it belongs to the landscape feature).
 */
export class WindClock {
    private _windClock = -1;

    /** See RenderSettings.effectsFollowTimeScale. */
    public effectsFollowTimeScale = false;
    /** The game's time scale this frame (Renderer.setEffectsTimeScale): the clock's rate while effects follow it. */
    public effectsTimeScale = 1;

    /**
     * The scene's wind field this frame (core/wind/windField.ts): the WindNode's parameters and the Force Fields that
     * move the air, captured once per frame, after `advanceWindTime`. Foliage uploads it to every wind program; the
     * particles sample the same snapshot, so everything rides one air.
     */
    public readonly windField = new WindFieldSnapshot();

    constructor(private readonly _view: FrameView) {}

    /**
     * Advance the render clock (`windTime`) by the render clock's frame delta (renderClock.ts: the wall clock, or a
     * movie's), clamped against a backgrounded tab, and scaled by the game's time scale when effects follow it: at
     * time ×2 the grass sways, the clouds drift and the rain falls twice as fast, a time-lapse rather than only the
     * sun moving faster.
     */
    public advanceWindTime(): void {
        const now = renderNow();
        // No clamp when a movie drives the clock: its step is exact, and a slow movie's is longer than 0.1 s.
        const cap = renderClockOverridden() ? Infinity : 0.1;
        const wall = this._windClock < 0 ? 0 : Math.min(cap, Math.max(0, (now - this._windClock) / 1000));
        this._windClock = now;
        const rate = this.effectsFollowTimeScale && Number.isFinite(this.effectsTimeScale) ? Math.max(0, this.effectsTimeScale) : 1;
        const dt = wall * rate;
        this._view.windTimePrev = this._view.windTime;
        this._view.windTime += dt;
        this._view.windDelta = dt;
        windFieldClock.time = this._view.windTime;
    }

    /**
     * Capture the wind field for this frame. The gusts' travel is integrated first, so a wind whose gust speed or size
     * is changing (a preset blending in) carries its gusts on rather than racing them.
     */
    public prepareWindField(scene: Scene): void {
        advanceGustTravel(windFieldClock, scene.wind, this._view.windDelta);
        this.windField.capture(scene, this._view.windTime, windFieldClock.gustTravel);
    }
}
