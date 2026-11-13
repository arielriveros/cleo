import { describe, it, expect } from 'vitest';
import {
    frameRateOf, frameTimestampUs, frameDurationUs, sampleTime, sampleJitter, frameCountFor, shutterFromAngle, frameStart,
} from '../src/sequencer/movie/movieTiming';
import { renderMovie, type MovieEngine, type MovieFrame } from '../src/sequencer/movie/renderMovie';
import { movieRenderSettings } from '../src/sequencer/movie/movieSettings';
import type { RenderSettings } from '../src/graphics/render/settingsTypes';

// A movie render's whole promise is that wall time cannot reach the file: frames and samples are taken at
// times derived from their index, the engine is stepped by exactly the gap to the next one, and every frame
// is drawn, settled and read before the next. These pin the timing arithmetic and, with a fake engine, the
// driver's order of work — including that an engine which takes random wall time per step produces the
// identical movie.

describe('movie timing', () => {
    it('holds frame rates exactly, NTSC included', () => {
        expect(frameRateOf(30)).toEqual({ num: 30, den: 1 });
        expect(frameRateOf(29.97)).toEqual({ num: 30000, den: 1001 });
        expect(frameRateOf(23.976)).toEqual({ num: 24000, den: 1001 });
        expect(frameRateOf(59.94)).toEqual({ num: 60000, den: 1001 });
        expect(frameRateOf(12.5)).toEqual({ num: 25, den: 2 });
        expect(() => frameRateOf(0)).toThrow();
    });

    it('timestamps frames from their index, so durations sum to the run with no drift', () => {
        const r30 = frameRateOf(30);
        expect(frameTimestampUs(0, r30)).toBe(0);
        expect(frameTimestampUs(1, r30)).toBe(33333);
        expect(frameTimestampUs(30, r30)).toBe(1_000_000);
        let sum = 0;
        for (let i = 0; i < 30; i++) sum += frameDurationUs(i, r30);
        expect(sum).toBe(1_000_000);
        const ntsc = frameRateOf(29.97);
        expect(frameTimestampUs(30000, ntsc)).toBe(1001 * 1_000_000);
        expect(frameTimestampUs(36000 * 30, ntsc)).toBe(Math.round(36000 * 30 * 1001 * 1e6 / 30000));
    });

    it('spreads samples over the open shutter from the frame start', () => {
        const r = frameRateOf(30);
        const s = { samples: 4, shutter: shutterFromAngle(180) };
        expect(s.shutter).toBe(0.5);
        expect(sampleTime(10, 0, r, s)).toBeCloseTo(10 / 30, 12);
        expect(sampleTime(10, 3, r, s) - sampleTime(10, 0, r, s)).toBeCloseTo(3 * 0.5 / (4 * 30), 12);
        // No shutter: every sample at the frame's start, only the jitter differs.
        expect(sampleTime(10, 3, r, { samples: 4, shutter: 0 })).toBe(frameStart(10, r));
        // A 360° shutter tiles time: the last sample is one sample-step short of the next frame.
        const full = { samples: 4, shutter: 1 };
        expect(frameStart(11, r) - sampleTime(10, 3, r, full)).toBeCloseTo(1 / (4 * 30), 12);
    });

    it('jitters samples by a centred, distinct sub-pixel pattern, and one sample not at all', () => {
        expect(sampleJitter(0, 1)).toBeNull();
        const set = Array.from({ length: 16 }, (_, k) => sampleJitter(k, 16)!);
        for (const [x, y] of set) { expect(Math.abs(x)).toBeLessThanOrEqual(0.5); expect(Math.abs(y)).toBeLessThanOrEqual(0.5); }
        const mx = set.reduce((a, [x]) => a + x, 0) / 16, my = set.reduce((a, [, y]) => a + y, 0) / 16;
        expect(Math.abs(mx)).toBeLessThan(1e-6);
        expect(Math.abs(my)).toBeLessThan(1e-6);
        expect(new Set(set.map(p => p.join(','))).size).toBe(16);
        expect(sampleJitter(17, 16)).toEqual(sampleJitter(1, 16));
    });

    it('counts the frames a range takes at time x1', () => {
        expect(frameCountFor(2, frameRateOf(30))).toBe(60);
        expect(frameCountFor(2, frameRateOf(29.97))).toBe(60);
        expect(frameCountFor(0, frameRateOf(30))).toBe(0);
    });
});

/** A fake engine: the sequence runs at `timeScale` x the movie clock and ends at `duration`. */
function fakeEngine(o: { duration: number; timeScale?: number; unsettledRenders?: number; slow?: boolean; loop?: boolean } = { duration: 2 }) {
    const log: string[] = [];
    let seq = 0, playing = true, paused = false, presented = false, sample = 0, samples = 1;
    let unsettled = 0, origin = -1, movieTime = 0, elapsed = 0;
    const busy = () => { if (!o.slow) return; const until = performance.now() + Math.random() * 2; while (performance.now() < until) { /* spin */ } };
    const engine: MovieEngine = {
        advance(dt) {
            busy();
            movieTime += dt;
            if (!playing) return;
            if (!paused) { seq += dt * (o.timeScale ?? 1); elapsed += dt * (o.timeScale ?? 1); }
            if (seq >= o.duration) { if (o.loop) seq -= o.duration; else { seq = o.duration; playing = false; } }
            log.push(`advance ${dt.toFixed(6)}`);
        },
        render() {
            busy();
            presented = sample === samples - 1;
            log.push(`render ${sample}/${samples} at ${movieTime.toFixed(6)}`);
            if (unsettled > 0) unsettled--;
        },
        setSample(k, n) { sample = k; samples = n; },
        get framePresented() { return presented; },
        async readFrame() { unsettled = o.unsettledRenders ?? 0; return new Uint8Array([Math.round(movieTime * 1000) % 256]); },
        async whenAssetsReady() { return true; },
        get lightingSettled() { return unsettled === 0; },
        snapExposure() { log.push('snap'); },
        sequenceElapsed() { return elapsed; },
        sequenceEnded() { return !playing; },
        sequenceHolding: false,
        setSequencePaused(p) { paused = p; log.push(p ? 'pause' : 'resume'); },
        async yield() { if (o.slow) await new Promise(r => setTimeout(r, Math.random() * 2)); },
        beginFrames() { origin = movieTime; log.push('frames'); },
    };
    return { engine, log, origin: () => origin };
}

async function run(engineOpts: Parameters<typeof fakeEngine>[0], options: Partial<Parameters<typeof renderMovie>[1]> = {}, abortAfter?: number) {
    const fake = fakeEngine(engineOpts);
    const frames: MovieFrame[] = [];
    const controller = new AbortController();
    const result = await renderMovie(fake.engine, {
        width: 4, height: 2, fps: 30, samples: 4, shutter: 0.5, from: 0, to: engineOpts!.duration, ...options,
    }, { frame: async f => { frames.push(f); if (abortAfter && frames.length >= abortAfter) controller.abort(); } },
       { signal: controller.signal });
    return { ...fake, frames, result };
}

describe('renderMovie', () => {
    it('films every whole frame of the range, each from its samples, stepped by exactly the gaps', async () => {
        const { frames, result, log } = await run({ duration: 2 });
        expect(result.reason).toBe('out');
        expect(frames).toHaveLength(60);
        expect(frames.map(f => f.timestampUs)).toEqual(Array.from({ length: 60 }, (_, i) => frameTimestampUs(i, frameRateOf(30))));
        expect(frames[59].movieTime).toBeCloseTo(59 / 30, 9);
        // Frame 1's renders: samples 0..3, at its start plus k/8 of a frame (half the frame, in quarters).
        const f1 = log.filter(l => l.startsWith('render') && !l.startsWith('render 0/1'))
                      .map(l => ({ k: l.split(' ')[1], t: Number(l.split(' at ')[1]) }))
                      .filter(r => r.t >= 1 / 30 - 1e-6 && r.t < 2 / 30 - 1e-6);
        expect(f1.map(r => r.k)).toEqual(['0/4', '1/4', '2/4', '3/4']);
        expect(f1.map(r => r.t)).toEqual([0, 1, 2, 3].map(k => Number((1 / 30 + k * 0.5 / (4 * 30)).toFixed(6))));
        const advances = log.filter(l => l.startsWith('advance')).map(l => Number(l.split(' ')[1]));
        expect(advances.reduce((a, b) => a + b, 0)).toBeCloseTo(60 / 30, 4);
    });

    it('is the same movie however long each step takes (no frame-time lag)', async () => {
        const fast = await run({ duration: 1 });
        const slow = await run({ duration: 1, slow: true });
        const shape = (r: typeof fast) => ({ frames: r.frames.map(f => [f.index, f.timestampUs, f.durationUs, f.movieTime, f.rgba[0]]),
                                              renders: r.log.filter(l => l.startsWith('render') || l.startsWith('advance')) });
        expect(shape(slow)).toEqual(shape(fast));
    });

    it('settles each frame after reading it, within the cap', async () => {
        const { result, log } = await run({ duration: 1, unsettledRenders: 5 }, { settleCap: 3 });
        expect(result.frames).toBe(30);
        // 4 samples + 3 settles per frame (capped), plus the warm-up.
        const perFrame = log.filter(l => l.startsWith('render 0/1')).length;
        expect(perFrame).toBeGreaterThanOrEqual(30 * 3);
    });

    it('drops a frame whose shutter would reach past the end, and ends with the sequence', async () => {
        // Time x2: the 1 s sequence is over in 0.5 movie seconds.
        const { frames, result } = await run({ duration: 1, timeScale: 2 });
        expect(result.reason).toBe('out');
        expect(frames.length).toBe(15);
        const ended = await run({ duration: 1 }, { to: 5 });
        expect(ended.result.reason).toBe('sequence-ended');
        expect(ended.frames.length).toBe(30);
    });

    it('stops on cancel, keeping what it filmed', async () => {
        const { frames, result } = await run({ duration: 2 }, {}, 10);
        expect(result.reason).toBe('cancelled');
        expect(frames).toHaveLength(10);
    });

    it('warms up, holds the sequence through the pre-roll, and starts the movie clock after it', async () => {
        const { log, frames, origin } = await run({ duration: 1 }, { preRoll: 0.5 });
        const pause = log.indexOf('pause'), resume = log.indexOf('resume'), start = log.indexOf('frames');
        expect(pause).toBeGreaterThan(-1);
        expect(resume).toBeGreaterThan(pause);
        expect(start).toBeGreaterThan(resume);
        expect(log.indexOf('snap')).toBeLessThan(start);
        expect(origin()).toBeCloseTo(0.5, 6);
        expect(frames).toHaveLength(30);
    });

    it('films one pass of a looping sequence', async () => {
        const { frames } = await run({ duration: 1, loop: true });
        expect(frames).toHaveLength(30);
    });
});

describe('movieRenderSettings', () => {
    const project = {
        quality: 'high', renderScale: 0.75, ssaoEnabled: false, ssaoSamples: 24, ssrSteps: 32, giRaysPerFrame: 131072,
        toneMapper: 'agx', exposureCompensation: 0.5, bloomIntensity: 0.3, motionBlurEnabled: true, motionBlurIntensity: 1,
        taaEnabled: true, fxaaEnabled: false, shadowMapResolution: 2048, shadowCascades: 3, shadowStagger: true,
        shadowFilterMode: 0, foliageCullDistance: 300,
    } as unknown as RenderSettings;

    it('raises what only costs time and keeps the look', () => {
        const s = movieRenderSettings(project, { samples: 16, shutter: 0.5, cinematic: true });
        expect(s.quality).toBe('ultra');
        expect(s.renderScale).toBe(1);
        expect(s.ssaoSamples).toBe(64);
        expect(s.giRaysPerFrame).toBe(1 << 20);
        expect(s.shadowMapResolution).toBe(4096);
        expect(s.shadowStagger).toBe(false);
        expect(s.occlusionQueries).toBe(false);
        // The look is the project's: what is on, the curve, the grade, the filter, the distances.
        expect(s.ssaoEnabled).toBe(false);
        expect(s.toneMapper).toBe('agx');
        expect(s.exposureCompensation).toBe(0.5);
        expect(s.bloomIntensity).toBe(0.3);
        expect(s.shadowFilterMode).toBe(0);
        expect(s.foliageCullDistance).toBe(300);
    });

    it('lets the samples anti-alias and blur, or with one sample sets the post blur to the shutter', () => {
        const many = movieRenderSettings(project, { samples: 8, shutter: 0.5, cinematic: false });
        expect([many.taaEnabled, many.fxaaEnabled, many.motionBlurEnabled]).toEqual([false, false, false]);
        expect(many.quality).toBe('high');
        const one = movieRenderSettings(project, { samples: 1, shutter: 0.25, cinematic: false });
        expect(one.taaEnabled).toBe(true);
        expect(one.motionBlurIntensity).toBe(0.25);
    });
});
