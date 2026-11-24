// The wait behind Renderer.prepareShaders: poll until nothing the scene can draw is still building, with
// frames of the scene drawn culled by nothing (a "sweep") so that everything off screen asks for its pipeline
// too. Pure of the renderer, so its rules are testable: the renderer hands in what to poll and counts the
// sweep frames it draws.

/** The sweep frames asked for and drawn. The renderer draws one, culled by nothing, while `wanted` > 0. */
export interface SweepFrames {
    wanted: number;
    rendered: number;
}

/** What the wait reads each tick. */
export interface ShaderWaitSource {
    /** Start or finish what has to be polled (a background compile is finished by asking again). */
    poll(): void;
    /** Whether anything is still building: pipelines off the main thread, background compiles, a warm-up. */
    building(): boolean;
    /** Builds begun and ended so far, ever (shaderActivity.counts). */
    counts(): { begun: number; ended: number };
    /** The warm-up's count while one runs, else null (shaderActivity's). */
    warm(): { done: number; total: number } | null;
}

export interface ShaderWaitOptions {
    /** Builds finished of builds started, the warm-up included. Both grow. */
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
    /** Give up after this long, in ms (default 5 minutes). */
    timeoutMs?: number;
    /** Sweep frames asked for at the start (default 2). */
    initialFrames?: number;
    /** A frame asked for and not drawn in this long means none will be (a hidden viewport). Default 3 s. */
    frameWaitMs?: number;
    /** The clock and the pause between ticks; real ones by default, fakes in the tests. */
    now?: () => number;
    pause?: () => Promise<void>;
}

export interface ShaderWaitResult {
    /** Builds that ended while it waited, the warm-up's included. */
    built: number;
    timedOut: boolean;
    aborted: boolean;
    /** No sweep frame could be drawn: the wait went on without them. */
    noFrames: boolean;
}

/**
 * Wait until nothing is building and a sweep frame drawn with everything in has started nothing new.
 *
 *  - `initialFrames` sweep frames first: what they draw asks for its pipelines.
 *  - Then, each time nothing is building, one more frame to confirm: a frame drawn with every pipeline in
 *    can reach draws that were skipped while one was building, and those may start more.
 *  - A frame that is not drawn within `frameWaitMs` ends the sweep (a hidden viewport draws none): the wait
 *    then ends as soon as nothing is building.
 */
export async function awaitShaders(source: ShaderWaitSource, frames: SweepFrames,
                                   options: ShaderWaitOptions = {}): Promise<ShaderWaitResult> {
    const now = options.now ?? (() => performance.now()); // wall-clock: how long a driver has been compiling
    const pause = options.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 16)));
    const limit = options.timeoutMs ?? 300_000;
    const frameWait = options.frameWaitMs ?? 3000;
    const t0 = now();
    const start = source.counts();
    frames.wanted = Math.max(frames.wanted, options.initialFrames ?? 2);

    let warmDone = 0, warmTotal = 0;
    let confirmAfter = -1, confirmBegun = -1;
    let seenRendered = frames.rendered, lastFrameAt = t0;
    let noFrames = false, timedOut = false, aborted = false;

    const report = (): { begun: number; ended: number } => {
        const counts = source.counts();
        const warm = source.warm();
        if (warm) { warmTotal = Math.max(warmTotal, warm.total); warmDone = warm.done; }
        else warmDone = warmTotal;
        options.onProgress?.(counts.ended - start.ended + warmDone, counts.begun - start.begun + warmTotal);
        return counts;
    };

    for (;;) {
        source.poll();
        const counts = report();
        const building = source.building();
        const t = now();
        if (frames.rendered !== seenRendered) { seenRendered = frames.rendered; lastFrameAt = t; }
        else if (frames.wanted > 0 && t - lastFrameAt > frameWait) { frames.wanted = 0; noFrames = true; }

        if (!building && frames.wanted === 0) {
            if (noFrames) break;
            if (confirmAfter >= 0 && frames.rendered > confirmAfter && counts.begun === confirmBegun) break;
            if (confirmAfter < 0 || frames.rendered > confirmAfter) {
                confirmAfter = frames.rendered;
                confirmBegun = counts.begun;
                frames.wanted = 1;
                lastFrameAt = t;
            }
        }
        if (options.signal?.aborted) { aborted = true; break; }
        if (t - t0 > limit) { timedOut = true; break; }
        await pause();
    }
    frames.wanted = 0;
    const end = report();
    return { built: end.ended - start.ended + warmDone, timedOut, aborted, noFrames };
}
