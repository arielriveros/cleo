/**
 * The clock every time-based render effect reads, in milliseconds.
 *
 * `performance.now()` by default. A movie render (src/sequencer/movie/) points it at the movie's own time, so
 * the wind, the clouds, flicker, material time, exposure adaptation, film grain and every throttle in the
 * renderer advance by exactly the frames rendered, however long each one took to draw. That is what keeps
 * a frame that took two seconds from showing two seconds of wind.
 *
 * Read this, never `performance.now()`, for anything that changes the image. `tests/renderClockIsolation.test.ts`
 * fails on a new wall-clock read under `src/graphics/` that is not a measurement (a profiler, a stall
 * record, a compile budget).
 */

let source: (() => number) | null = null;

/** The render clock, in milliseconds. */
export function renderNow(): number {
    return source ? source() : performance.now();
}

/** Point the render clock at `fn` (milliseconds), or back at the wall clock with null. */
export function setRenderClock(fn: (() => number) | null): void {
    source = fn;
}

/**
 * True while something other than the wall clock drives the render clock. Clamps that exist to survive a
 * backgrounded tab (a frame delta capped at a tenth of a second) do not apply then: a movie's frame
 * step is exact, and a 5 fps movie's 0.2 s must not be cut to 0.1.
 */
export function renderClockOverridden(): boolean {
    return source !== null;
}
