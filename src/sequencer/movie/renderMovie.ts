import {
    frameRateOf, frameStart, frameTimestampUs, frameDurationUs, sampleTime, sampleJitter, frameCountFor,
    type FrameRate,
} from './movieTiming';

/**
 * Render a sequence to movie frames, offline: the engine stepped by exactly the time between samples, every
 * frame drawn and settled before it is read, and handed to a sink with timestamps from its index. The
 * engine never runs on its own clock meanwhile (MovieEngine is the seam: movieEngine.ts drives a real
 * CleoEngine through it, the tests a fake one), so a frame that takes ten seconds to draw shows the same
 * thing as one that takes ten milliseconds.
 *
 * Per frame:
 *   1. wait for what a frame shows to be ready (programs, textures, the exposure reading);
 *   2. for each sample: step the engine to the sample's moment, then render it with its jitter (the renderer
 *      folds it into the frame's mean and resolves the last one);
 *   3. read the frame back and hand it to the sink (which may push back: its promise paces the loop);
 *   4. settle: render the same moment again until no lighting work is half done (GI sweeps, probe jobs, sky
 *      bakes), so the next frame's light is converged. Settling AFTER the read, at the frame's own state,
 *      keeps the next frame's motion vectors (this state to the next) right.
 *
 * The movie ends on the frame whose samples would reach Out, or on the sequence ending (finished, stopped by
 * a script, or once round a looping one) — never by counting frames, because time-scale keys change how
 * many there are.
 */

/** What the driver needs of an engine. */
export interface MovieEngine {
    /** Advance the game by `seconds` of real time — physics, scripts, the sequence — without rendering. */
    advance(seconds: number): void;
    /** Render the current state (into the movie's target, through its sample mean). */
    render(): void;
    /** Declare which sample of how many the next render is, and its sub-pixel offset. */
    setSample(sample: number, samples: number, jitter: [number, number] | null): void;
    /** True when the last render resolved a finished frame. */
    readonly framePresented: boolean;
    /** The finished frame, RGBA top row first. */
    readFrame(): Promise<Uint8Array>;
    /** Resolves when no program, texture or meter reading is still on its way (false if it gave up waiting). */
    whenAssetsReady(): Promise<boolean>;
    /** True when no lighting work is half done. */
    readonly lightingSettled: boolean;
    /** Snap auto exposure to its last reading (the warm-up's end: the first frame must not be adapting). */
    snapExposure(): void;
    /** Seconds of sequence played since the movie began, counting a loop's wrap as time played. */
    sequenceElapsed(): number;
    /** True once the sequence stopped or finished. */
    sequenceEnded(): boolean;
    /** True while a hold section keeps the sequence waiting. */
    readonly sequenceHolding: boolean;
    /** Hold the sequence where it is (pre-roll) or let it go on. */
    setSequencePaused(paused: boolean): void;
    /** Let the page breathe (a progress repaint, a Cancel click), without depending on timers. */
    yield(): Promise<void>;
    /** The warm-up is over: the next render is frame 0, the movie's time zero (its sound's too). */
    beginFrames(): void;
}

export interface MovieRenderOptions {
    width: number;
    height: number;
    fps: number;
    /** Renders averaged into each frame. 1 = the picture Play shows (its own TAA and motion blur). */
    samples: number;
    /** The shutter as a fraction of the frame (180° = 0.5). */
    shutter: number;
    /** Sequence seconds the movie starts and ends at. */
    from: number;
    to: number;
    /** Seconds the scene runs with the sequence held at In before the first frame (particles, cloth). 0 = none. */
    preRoll?: number;
    /** Most renders the warm-up spends settling (default 600). */
    warmupSettleCap?: number;
    /** Most renders a frame spends settling after it is read (default 120). */
    settleCap?: number;
}

/** One finished frame. */
export interface MovieFrame {
    index: number;
    /** Presentation time and duration in microseconds, from the frame's index. */
    timestampUs: number;
    durationUs: number;
    width: number;
    height: number;
    /** Tightly packed RGBA, top row first. */
    rgba: Uint8Array;
    /** The movie's own time (unscaled seconds) and the sequence's, at the frame's start. */
    movieTime: number;
    sequenceTime: number;
}

/** Where frames go (an encoder, a PNG writer, a test). `frame`'s promise paces the render. */
export interface MovieSink {
    frame(frame: MovieFrame): Promise<void>;
}

export interface MovieProgress {
    /** Frames finished so far. */
    frames: number;
    /** Sequence seconds reached, and the range. */
    sequenceTime: number;
    from: number;
    to: number;
    /** An estimate of the frame count at time ×1 (time-scale keys change the real one). */
    estimatedFrames: number;
    /** Renders spent settling the last frame, and in all. */
    settleRenders: number;
    totalRenders: number;
    /** 'warmup' before the first frame; 'held' while a hold section waits; else 'rendering'. */
    phase: 'warmup' | 'rendering' | 'held';
}

export type MovieEndReason = 'out' | 'sequence-ended' | 'cancelled';

export interface MovieResult {
    frames: number;
    reason: MovieEndReason;
    /** Every render the movie took: samples, settles and the warm-up. */
    renders: number;
    /** Movie seconds rendered (frames × frame length). */
    seconds: number;
}

export interface MovieRunControls {
    signal?: AbortSignal;
    onProgress?: (progress: MovieProgress) => void;
}

/** The sequence time a frame starts at, for the progress line. */
function sequenceTimeOf(engine: MovieEngine, from: number): number {
    return from + engine.sequenceElapsed();
}

export async function renderMovie(engine: MovieEngine, options: MovieRenderOptions, sink: MovieSink,
                                  controls: MovieRunControls = {}): Promise<MovieResult> {
    const rate: FrameRate = frameRateOf(options.fps);
    const samples = Math.max(1, Math.floor(options.samples));
    const shutter = Math.min(1, Math.max(0, options.shutter));
    const settings = { samples, shutter };
    const from = Math.max(0, options.from);
    const to = Math.max(from, options.to);
    const settleCap = Math.max(0, options.settleCap ?? 120);
    const warmupCap = Math.max(1, options.warmupSettleCap ?? 600);
    const estimatedFrames = frameCountFor(to - from, rate);
    const signal = controls.signal;
    let renders = 0;
    let settleRenders = 0;

    const report = (frames: number, phase: MovieProgress['phase']) => controls.onProgress?.({
        frames, sequenceTime: sequenceTimeOf(engine, from), from, to, estimatedFrames,
        settleRenders, totalRenders: renders, phase,
    });
    const render = () => { engine.render(); renders++; };
    /** Render the current moment until the light settles or `cap` renders: one plain sample each. */
    const settle = async (cap: number, minimum = 0): Promise<number> => {
        engine.setSample(0, 1, null);
        let n = 0;
        while (n < minimum || (!engine.lightingSettled && n < cap)) {
            if (signal?.aborted) break;
            render();
            n++;
            if (n % 8 === 0) await engine.yield();
        }
        return n;
    };

    // --- warm-up: the first frame starts converged ------------------------------------------------
    report(0, 'warmup');
    await engine.whenAssetsReady();
    // Three renders at least: the meter's first reading has to be taken, read back and applied.
    settleRenders = await settle(warmupCap, 3);
    await engine.whenAssetsReady();
    engine.snapExposure();
    const preRoll = Math.max(0, options.preRoll ?? 0);
    if (preRoll > 0 && !signal?.aborted) {
        engine.setSequencePaused(true);
        const step = 1 / framesPerSecondOf(rate);
        for (let t = 0; t < preRoll - 1e-9 && !signal?.aborted; t += step) {
            engine.advance(Math.min(step, preRoll - t));
            engine.setSample(0, 1, null);
            render();
            if (renders % 8 === 0) await engine.yield();
        }
        engine.setSequencePaused(false);
        settleRenders = await settle(warmupCap);
        await engine.whenAssetsReady();
        engine.snapExposure();
    }
    await engine.yield();

    // --- the frames -------------------------------------------------------------------------------
    engine.beginFrames();
    let movieTime = 0;
    let frames = 0;
    let reason: MovieEndReason = 'out';
    frameLoop:
    for (let index = 0; ; index++) {
        if (signal?.aborted) { reason = 'cancelled'; break; }
        if (engine.sequenceEnded()) { reason = 'sequence-ended'; break; }
        // A hold section needs nothing special: the game runs on, frames and all, until a script lets the
        // sequence go (the progress says 'held', and a hold nobody releases is the user's to cancel).
        await engine.whenAssetsReady();
        const sequenceTime = sequenceTimeOf(engine, from);
        const frameMovieTime = frameStart(index, rate);
        for (let k = 0; k < samples; k++) {
            const target = sampleTime(index, k, rate, settings);
            const dt = target - movieTime;
            movieTime = target;
            if (dt > 0) engine.advance(dt);
            // A frame whose shutter would reach past the end is not filmed: the last frame is the last whole one.
            if (sequenceTimeOf(engine, from) >= to - 1e-9) { reason = 'out'; break frameLoop; }
            if (engine.sequenceEnded()) { reason = 'sequence-ended'; break frameLoop; }
            engine.setSample(k, samples, sampleJitter(k, samples));
            render();
        }
        if (!engine.framePresented)
            throw new Error(`Movie frame ${index} was not drawn (no active camera, or the renderer refused the frame)`);
        const rgba = await engine.readFrame();
        await sink.frame({
            index, timestampUs: frameTimestampUs(index, rate), durationUs: frameDurationUs(index, rate),
            width: options.width, height: options.height, rgba, movieTime: frameMovieTime, sequenceTime,
        });
        frames++;
        settleRenders = settleCap > 0 ? await settle(settleCap) : 0;
        report(frames, engine.sequenceHolding ? 'held' : 'rendering');
        await engine.yield();
    }
    return { frames, reason, renders, seconds: frameStart(frames, rate) };
}

function framesPerSecondOf(rate: FrameRate): number {
    return rate.num / rate.den;
}
