/**
 * Mouse-look glitch rejection under pointer lock.
 *
 * Chromium (and so Electron) occasionally reports one `mousemove` whose `movementX/Y` is hundreds of pixels while
 * the mouse barely moved: on the event that follows a lock change, and when the OS warps its hidden cursor back
 * to the centre. Added to a camera's yaw, that one event is the view "snapping" to another direction. Raw input
 * (`unadjustedMovement`) avoids most of it where the platform has it; this catches the rest.
 *
 * A real flick ramps up over several events, even on a 125 Hz mouse; a glitch arrives out of nowhere. So an event
 * is dropped only when it is both large in absolute terms and many times larger than everything just before it.
 */

/** Events remembered for the comparison. */
export const POINTER_SPIKE_HISTORY = 4;
/** Below this many pixels an event is never a glitch, however still the mouse was before it. */
export const POINTER_SPIKE_MIN_PX = 150;
/** How many times the largest recent event a glitch is. */
export const POINTER_SPIKE_RATIO = 8;
/** The quietest "recent motion" an event is compared against, so a mouse at rest does not make 20 px a spike. */
export const POINTER_SPIKE_FLOOR_PX = 4;

export interface PointerSpikeFilter {
    /** Magnitudes of the last accepted (or dropped) events, newest last. */
    recent: number[];
    /** Drop the next event outright: set on every pointer-lock change. */
    dropNext: boolean;
}

export function createPointerSpikeFilter(): PointerSpikeFilter {
    return { recent: [], dropNext: false };
}

/**
 * Whether the event (`dx`, `dy` in pixels) is a glitch to drop. Records the event in the filter either way. A
 * dropped one is remembered as `POINTER_SPIKE_MIN_PX`, not its own size: that is enough that a genuine flick
 * which happened to open with one big event is let through from its second event on, and not so much that the
 * glitch licenses an even bigger one after it.
 */
export function pointerSpike(filter: PointerSpikeFilter, dx: number, dy: number): boolean {
    const magnitude = Math.hypot(dx, dy);
    if (!Number.isFinite(magnitude)) return true;
    let drop = false;
    if (filter.dropNext) {
        filter.dropNext = false;
        drop = magnitude > 0;
    } else if (magnitude > POINTER_SPIKE_MIN_PX) {
        let largest = POINTER_SPIKE_FLOOR_PX;
        for (const m of filter.recent) largest = Math.max(largest, m);
        drop = magnitude > largest * POINTER_SPIKE_RATIO;
    }
    filter.recent.push(drop ? Math.min(magnitude, POINTER_SPIKE_MIN_PX) : magnitude);
    if (filter.recent.length > POINTER_SPIKE_HISTORY) filter.recent.shift();
    return drop;
}
