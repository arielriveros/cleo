import { describe, it, expect } from 'vitest';
import { awaitShaders, type ShaderWaitSource, type SweepFrames } from '../src/graphics/render/shaderSweep';
import { methodBody } from './helpers/rendererSource';

// Renderer.prepareShaders holds the editor's loading screen until nothing the scene can draw is still building.
// Its frames draw the scene culled by nothing, so what is off screen asks for its pipeline too; it is done when
// nothing is building and one more such frame, drawn with all of it in, starts nothing new.
//
// A fake world: a clock that moves 16 ms a tick, a renderer that draws a sweep frame on each tick one is
// wanted (unless the viewport is hidden), and builds that finish after a set number of ticks.

interface World {
    source: ShaderWaitSource;
    frames: SweepFrames;
    now: () => number;
    pause: () => Promise<void>;
    /** Start a build lasting `ticks` ticks. */
    build(ticks: number): void;
    /** What each sweep frame starts, by its index (0-based). */
    onFrame: (index: number) => void;
    hidden: boolean;
    warm: { done: number; total: number } | null;
    progress: [number, number][];
}

function world(): World {
    let t = 0, begun = 0, ended = 0;
    const running: number[] = [];   // ticks left per build
    const w: World = {
        frames: { wanted: 0, rendered: 0 },
        now: () => t,
        pause: async () => {
            t += 16;
            for (let i = running.length - 1; i >= 0; i--) if (--running[i] <= 0) { running.splice(i, 1); ended++; }
            if (w.frames.wanted > 0 && !w.hidden) {
                w.frames.wanted--;
                w.onFrame(w.frames.rendered);
                w.frames.rendered++;
            }
        },
        build(ticks) { begun++; running.push(ticks); },
        onFrame: () => {},
        hidden: false,
        warm: null,
        progress: [],
        source: {
            poll: () => {},
            building: () => running.length > 0 || w.warm !== null,
            counts: () => ({ begun, ended }),
            warm: () => w.warm,
        },
    };
    return w;
}

const run = (w: World, extra: Parameters<typeof awaitShaders>[2] = {}) =>
    awaitShaders(w.source, w.frames, { now: w.now, pause: w.pause, onProgress: (d, n) => w.progress.push([d, n]), ...extra });

describe('waiting for a scene\'s shaders', () => {
    it('sweeps, waits for what the frames started, and confirms with one more frame', async () => {
        const w = world();
        w.onFrame = i => { if (i === 0) { w.build(10); w.build(20); } };
        const result = await run(w);
        expect(result).toMatchObject({ built: 2, timedOut: false, aborted: false, noFrames: false });
        // Two sweep frames, then the confirming one once both builds were in.
        expect(w.frames.rendered).toBe(3);
        expect(w.progress.at(-1)).toEqual([2, 2]);
        // The count only ever grows towards the total.
        expect(w.progress.some(([d, n]) => d < n)).toBe(true);
    });

    it('waits again when the confirming frame reaches draws that start more', async () => {
        const w = world();
        // Frame 2 is the first confirmation: drawn with frame 0's build in, it reaches one that was skipped.
        w.onFrame = i => { if (i === 0) w.build(5); if (i === 2) w.build(5); };
        const result = await run(w);
        expect(result.built).toBe(2);
        expect(w.frames.rendered).toBe(4);
    });

    it('ends as soon as nothing builds when no frame can be drawn (a hidden viewport)', async () => {
        const w = world();
        w.hidden = true;
        w.build(3);
        const result = await run(w, { frameWaitMs: 100 });
        expect(result).toMatchObject({ built: 1, noFrames: true, timedOut: false });
        expect(w.frames.rendered).toBe(0);
        expect(w.now()).toBeLessThan(200);
    });

    it('waits for a warm-up to the end, counting it, though nothing builds between its batches', async () => {
        const w = world();
        w.warm = { done: 0, total: 4 };
        let ticks = 0;
        w.source.poll = () => {
            ticks++;
            if (w.warm && ticks % 5 === 0) w.warm = w.warm.done + 1 >= w.warm.total ? null : { done: w.warm.done + 1, total: 4 };
        };
        const result = await run(w);
        expect(w.warm).toBeNull();
        expect(result.built).toBe(4);
        expect(w.progress.at(-1)).toEqual([4, 4]);
    });

    it('gives up at its time limit, saying so', async () => {
        const w = world();
        w.build(1_000_000);
        const result = await run(w, { timeoutMs: 1000 });
        expect(result).toMatchObject({ timedOut: true, built: 0 });
        expect(w.frames.wanted).toBe(0);
    });

    it('stops when its signal is aborted (the project closing)', async () => {
        const w = world();
        w.build(1_000_000);
        const abort = new AbortController();
        w.onFrame = i => { if (i === 1) abort.abort(); };
        const result = await run(w, { signal: abort.signal });
        expect(result).toMatchObject({ aborted: true, timedOut: false });
    });

    it('finishes in two frames and a confirmation when there is nothing to build', async () => {
        const w = world();
        const result = await run(w);
        expect(result).toMatchObject({ built: 0, timedOut: false, noFrames: false });
        expect(w.frames.rendered).toBe(3);
    });
});

// What a sweep frame does that a normal frame does not, read off the renderer's source (a Renderer needs a GPU). Each
// one is something the Sandbox's first shot met for the first time in play: copies of what the scene can spawn,
// stepped so their particles emit; a program compiled in the background held for; a post effect switched on later;
// a velocity draw for something that only moves later.
describe('a sweep frame', () => {
    it('steps the copies of what the scene can spawn before it draws', () => {
        const body = methodBody('render');
        const step = body.indexOf('sweep.warmup?.beforeFrame(');
        expect(step).toBeGreaterThan(-1);
        expect(step).toBeLessThan(body.indexOf('this._renderFrame(scene)'));
    });

    it('waits for programs compiling in the background, and resets the history the copies were drawn into', () => {
        const body = methodBody('prepareShaders');
        expect(body).toMatch(/building: \(\) => [^\n]*compileQueue\.pendingCount/);
        // Any sweep that drew resets the history (below); one that drew copies of what the scene can spawn snaps the
        // exposure too.
        expect(body).toContain('if (options.warmup?.count) this.snapExposure();');
    });

    it('runs the post effects a script can switch on, whatever their settings', () => {
        const body = methodBody('_buildPostGraph');
        expect(body).toContain('const sweeping = this._visibility.sweeping;');
        for (const gate of ['chromaticAberrationStrength <= 0 && !sweeping', 'this._post.dofMaxBlur <= 0) && !sweeping',
                            'lensFlareIntensity <= 0 && !sweeping', 'vignetteStrength <= 0 && !sweeping', 'filmGrainIntensity <= 0 && !sweeping'])
            expect(body).toContain(gate);
    });

    it('draws every model\'s velocity, moved or not', () => {
        expect(methodBody('_selectMover')).toContain("!this._nodeMoved(node) && !this._sys.visibility.sweeping");
    });
});

// The effects a script can switch on in play, built during the loading step: those with no buffers of their own run in
// the sweep frames (as depth of field does); those that keep history are asked for by key, without running.
describe('a sweep frame, for what a script switches on later', () => {
    it('runs bloom, FXAA and motion blur whatever their settings', () => {
        const post = methodBody('_buildPostGraph');
        expect(post).toContain('(this._post.bloomIntensity <= 0 && !sweeping)');
        expect(post).toContain('(this._post.fxaaEnabled || this._view.preview || sweeping)');
        const frame = methodBody('_renderFrame');
        expect(frame).toMatch(/motionBlurWillRun = this\._view\.hasPrevViewProj[\s\S]*?this\._visibility\.sweeping/);
    });

    it('asks once for the pipelines of the effects that keep history, and resets the history after', () => {
        const prepare = methodBody('prepareShaders');
        expect(prepare).toContain('if (!prefetched) { prefetched = true; this._prefetchEffects(scene, prefetch); }');
        expect(prepare).toContain('prefetch.dispose()');
        expect(prepare).toContain('if (sweep.rendered > 0) this.invalidateTemporalHistory();');
        const effects = methodBody('_prefetchEffects');
        for (const sys of ['_temporal', '_ssr', '_ssil', '_radiance', '_fog', '_clouds', '_autoExposure'])
            expect(effects).toContain(`this.${sys}.prefetchPipelines(prefetch`);
    });
});
