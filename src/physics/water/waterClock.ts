// The clock the water's waves run on, shared by the physics and the renderer, so a floating body rides
// exactly the wave that is drawn under it. While the game's physics steps, it is the time its bodies are
// DRAWN at (physics/executor: the worker draws a little behind its clock); otherwise (the editor, or no
// physics) the renderer's own effects clock. Worker-safe: nothing to import.

/** How long the physics' time stays the water's clock after the physics last stepped (real ms). */
const FRESH_MS = 250;

export const waterClock = {
    /** The physics' drawn time at its last update (game seconds). */
    time: 0,
    /** When it was set (performance.now()). */
    updatedAt: -Infinity,
};

/** The physics stepped: its bodies are drawn at `time`. */
export function setWaterClock(time: number): void {
    waterClock.time = time;
    waterClock.updatedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** The water's time now: the physics' drawn time while the physics steps, else `fallback` (the render clock). */
export function waterTime(fallback: number): number {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return now - waterClock.updatedAt < FRESH_MS ? waterClock.time : fallback;
}
