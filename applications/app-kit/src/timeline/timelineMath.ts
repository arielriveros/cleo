// The arithmetic every timeline in the apps shares: seconds to pixels and back with a left gutter and a
// horizontal scroll, zoom limits and steps, fit-to-width, frame snapping, the ruler's adaptive ticks, a
// timecode, and the threshold that tells a click from a drag.
//
// Lifted from the Creator's Motion timeline (creator/src/motion/ui/TimelinePanel.tsx), where it was written
// inline, so the editor's Sequencer and that timeline cannot drift apart. Pure: no DOM, no React.

/** Zoom bounds, pixels per second. */
export const MIN_PX_PER_SEC = 20;
export const MAX_PX_PER_SEC = 2000;

/** The ruler's major tick spacings, seconds, smallest first. */
export const RULER_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];

/** The x of time `t` inside the scrolled content (the gutter is the content's left margin). */
export function timeToX(t: number, pxPerSec: number, gutter = 0): number {
    return gutter + t * pxPerSec;
}

/**
 * The time under a pointer: `clientX` relative to the scroller's left edge, plus how far it is scrolled,
 * less the gutter. Never negative.
 */
export function xToTime(clientX: number, rectLeft: number, scrollLeft: number, pxPerSec: number, gutter = 0): number {
    return Math.max(0, (clientX - rectLeft + scrollLeft - gutter) / pxPerSec);
}

/** `t` on the nearest frame of `fps`. */
export function snapToFps(t: number, fps: number): number {
    return fps > 0 ? Math.round(t * fps) / fps : t;
}

export function clampZoom(pxPerSec: number, min = MIN_PX_PER_SEC, max = MAX_PX_PER_SEC): number {
    return Math.min(max, Math.max(min, pxPerSec));
}

/** One wheel notch of zoom: in for a negative `deltaY` (wheel up), out for a positive one. */
export function zoomStep(pxPerSec: number, deltaY: number, factor = 1.15, min = MIN_PX_PER_SEC, max = MAX_PX_PER_SEC): number {
    return clampZoom(deltaY < 0 ? pxPerSec * factor : pxPerSec / factor, min, max);
}

/**
 * The zoom that fits `end` seconds into a viewport `viewportW` pixels wide, past the gutter and a margin.
 * A long timeline (a minutes-long sequence) passes a lower `min` than a clip's default.
 */
export function fitZoom(viewportW: number, end: number, gutter = 0, pad = 40, min = MIN_PX_PER_SEC, max = MAX_PX_PER_SEC): number {
    return clampZoom((viewportW - gutter - pad) / Math.max(1e-3, end), min, max);
}

export interface RulerTick { t: number; major: boolean; }

/**
 * The ruler's ticks from `from` to `to` seconds: the smallest major spacing at least `minMajorPx` apart, and
 * four minor ticks between majors. Limited to the visible range, so a long sequence costs only what shows.
 */
export function rulerTicks(from: number, to: number, pxPerSec: number, minMajorPx = 70,
                           steps: readonly number[] = RULER_STEPS): RulerTick[] {
    const major = steps.find(s => s * pxPerSec >= minMajorPx) ?? steps[steps.length - 1];
    const minor = major / 5;
    const out: RulerTick[] = [];
    const first = Math.max(0, Math.floor(from / minor));
    for (let i = first; i * minor <= to + 1e-6; i++) out.push({ t: i * minor, major: i % 5 === 0 });
    return out;
}

/** A ruler label: seconds without trailing zeros ("2s", "0.25s"), minutes past a minute ("1:30"). */
export function formatTick(t: number): string {
    if (t >= 60) {
        const m = Math.floor(t / 60), s = t - m * 60;
        return `${m}:${String(Math.round(s * 100) / 100).padStart(2, '0')}`;
    }
    return `${+t.toFixed(2)}s`;
}

/** "mm:ss.ff" — minutes, seconds and the frame within the second at `fps`. */
export function formatTimecode(t: number, fps: number): string {
    const total = Math.max(0, t);
    const m = Math.floor(total / 60);
    const s = Math.floor(total - m * 60);
    const f = fps > 0 ? Math.min(Math.round(fps) - 1, Math.floor((total - m * 60 - s) * fps + 1e-6)) : 0;
    const pad = (v: number) => String(v).padStart(2, '0');
    return `${pad(m)}:${pad(s)}.${pad(f)}`;
}

/** Whether a pointer has moved far enough from where it went down to count as a drag rather than a click. */
export function passedDragThreshold(dx: number, dy = 0, px = 3): boolean {
    return Math.hypot(dx, dy) >= px;
}

/**
 * Snap `t` to the nearest of `targets` (section edges, keys, the playhead, markers) within `tolerancePx`
 * pixels, else to the frame grid when `fps` is given. Returns the snapped time.
 */
export function snapTime(t: number, targets: readonly number[], pxPerSec: number, tolerancePx = 6, fps = 0): number {
    let best = t, bestPx = tolerancePx;
    for (const target of targets) {
        const d = Math.abs(target - t) * pxPerSec;
        if (d <= bestPx) { bestPx = d; best = target; }
    }
    if (best !== t) return best;
    return fps > 0 ? snapToFps(t, fps) : t;
}
