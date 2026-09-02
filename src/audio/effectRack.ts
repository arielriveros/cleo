import { rackShapeOf } from "./soundSettings";
import type { SoundEffect } from "./soundSettings";

/**
 * The DSP rack: an ordered chain of inserts between a fixed input and a fixed output node.
 *
 * Howler has no effects of its own, so this is stock Web Audio built on howler's `AudioContext` and
 * spliced into its graph. The whole signal path a sample takes is:
 *
 *     [howler voice] -> (panner, when spatial) -> voice gain -> RACK -> bus gain -> Howler.masterGain
 *
 * `input` and `output` are created once and NEVER replaced. That is what lets `attach` connect a voice
 * to the rack and forget about it: rebuilding the chain rewires only what sits between them, so a voice
 * that is already playing keeps its connection and stays audible across a rebuild.
 *
 * REBUILD VS TUNE is the other half of the same concern. Dragging a cutoff slider must not disconnect
 * nodes under a sounding note — that is audible as a click — so a parameter edit goes through `tune`,
 * which writes to AudioParams in place, and only a change of SHAPE (which inserts, in what order, which
 * of them enabled — see `rackShapeOf`) is allowed to touch the graph. `apply` decides which one to run.
 */

/** One insert, reduced to what the chain needs to know: where signal enters, where it leaves. */
type Insert = {
    kind: SoundEffect['kind'];
    in: AudioNode;
    out: AudioNode;
    tune(effect: SoundEffect): void;
    dispose(): void;
};

/**
 * The `WaveShaperNode` transfer curve for a given drive, 0..1. A classic soft-clip.
 *
 * The buffer is allocated explicitly so the return type is `Float32Array<ArrayBuffer>` rather than the
 * `ArrayBufferLike` TypeScript infers — `WaveShaperNode.curve` will not accept a possibly-shared buffer.
 */
function distortionCurve(drive: number): Float32Array<ArrayBuffer> {
    const samples = 1024;
    const curve = new Float32Array(new ArrayBuffer(samples * Float32Array.BYTES_PER_ELEMENT));
    // Zero drive must be a straight line, or an insert nobody has turned up still colours the sound.
    const k = Math.max(0, drive) * 100;
    const deg = Math.PI / 180;
    for (let i = 0; i < samples; i++) {
        const x = (i * 2) / samples - 1;
        curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

/**
 * A synthetic impulse response: white noise under an exponential decay envelope, with `preDelay` seconds
 * of silence in front of it.
 *
 * Generated rather than loaded so the engine ships no IR files and a project needs no reverb asset. It is
 * not a convolution of a real room, but for a game mixer "how long does it ring" is the control that
 * matters, and that is exactly what `decay` is.
 */
function buildImpulse(ctx: BaseAudioContext, decay: number, preDelay: number): AudioBuffer {
    const rate = ctx.sampleRate;
    const head = Math.floor(Math.max(0, preDelay) * rate);
    const tail = Math.max(1, Math.floor(Math.max(0.05, decay) * rate));
    const buffer = ctx.createBuffer(2, head + tail, rate);
    for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < tail; i++) {
            // Amplitude falls as (1 - t)^3: steeper than linear, which is what reads as a room rather
            // than a gated noise burst.
            const t = i / tail;
            data[head + i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3);
        }
    }
    return buffer;
}

export class EffectRack {
    private readonly _ctx: BaseAudioContext;
    private readonly _input: GainNode;
    private readonly _output: GainNode;
    private _inserts: Insert[] = [];
    /** The shape the current graph was built for; `null` until the first build. */
    private _shape: string | null = null;

    constructor(ctx: BaseAudioContext) {
        this._ctx = ctx;
        this._input = ctx.createGain();
        this._output = ctx.createGain();
        // Straight through until something is inserted. An empty rack must be inaudible, not silent.
        this._input.connect(this._output);
    }

    public get input(): AudioNode { return this._input; }
    public get output(): AudioNode { return this._output; }

    /**
     * Bring the rack in line with `effects`, rebuilding only when the shape demands it.
     * This is the only method callers need; `rebuild` and `tune` are exposed for tests and for the
     * editor's preview path, which knows which of the two it wants.
     */
    public apply(effects: SoundEffect[]): void {
        const shape = rackShapeOf(effects);
        if (shape === this._shape) this.tune(effects);
        else this.rebuild(effects);
    }

    /** Tear the chain down and build it again from `effects`. Disabled inserts are simply not built. */
    public rebuild(effects: SoundEffect[]): void {
        this._teardown();

        for (const effect of effects) {
            if (!effect.enabled) continue;
            const insert = this._build(effect);
            if (insert) {
                insert.tune(effect);
                this._inserts.push(insert);
            }
        }

        // Relink: input -> i0 -> i1 -> ... -> output. `_teardown` already disconnected the input, so the
        // straight-through connection cannot survive alongside the chain and double the signal.
        let cursor: AudioNode = this._input;
        for (const insert of this._inserts) {
            cursor.connect(insert.in);
            cursor = insert.out;
        }
        cursor.connect(this._output);

        this._shape = rackShapeOf(effects);
    }

    /**
     * Write new parameters into the existing graph. Silently does nothing for an effect whose insert is
     * not built (a disabled one), so a caller may pass the full authored list either way.
     */
    public tune(effects: SoundEffect[]): void {
        const enabled = effects.filter(e => e.enabled);
        // Positional, and safe to be: `apply` only reaches here when the shape matched, which means the
        // enabled inserts are the same kinds in the same order.
        for (let i = 0; i < this._inserts.length && i < enabled.length; i++) {
            this._inserts[i].tune(enabled[i]);
        }
    }

    /**
     * Route a howler voice's output node through this rack.
     *
     * Howler builds a fresh gain node per voice and connects it straight to its master gain, so this has
     * to run on every `play` — including replays of a pooled voice, which is why it is written to be
     * idempotent: disconnecting a node that is not connected is a no-op, not an error.
     */
    public attach(voiceNode: AudioNode | null | undefined): void {
        if (!voiceNode) return;
        try { voiceNode.disconnect(); } catch { /* never connected yet */ }
        voiceNode.connect(this._input);
    }

    public dispose(): void {
        this._teardown();
        try { this._output.disconnect(); } catch { /* already detached */ }
        this._shape = null;
    }

    /** Drop every insert and leave `input` connected straight to `output`. */
    private _teardown(): void {
        try { this._input.disconnect(); } catch { /* nothing connected */ }
        for (const insert of this._inserts) {
            try { insert.out.disconnect(); } catch { /* nothing connected */ }
            insert.dispose();
        }
        this._inserts = [];
        this._input.connect(this._output);
    }

    private _build(effect: SoundEffect): Insert | null {
        const ctx = this._ctx;
        switch (effect.kind) {
            case 'filter': {
                const filter = ctx.createBiquadFilter();
                return {
                    kind: 'filter', in: filter, out: filter,
                    tune: e => {
                        if (e.kind !== 'filter') return;
                        filter.type = e.type;
                        filter.frequency.value = e.frequency;
                        filter.Q.value = e.q;
                    },
                    dispose: () => { try { filter.disconnect(); } catch { /* detached */ } },
                };
            }

            case 'distortion': {
                const shaper = ctx.createWaveShaper();
                let lastDrive = -1;
                return {
                    kind: 'distortion', in: shaper, out: shaper,
                    tune: e => {
                        if (e.kind !== 'distortion') return;
                        shaper.oversample = e.oversample;
                        // The curve is 1024 samples; rebuilding it on every mousemove of a slider is
                        // wasted work, and reassigning `.curve` re-reads the whole array either way.
                        if (e.drive !== lastDrive) {
                            shaper.curve = distortionCurve(e.drive);
                            lastDrive = e.drive;
                        }
                    },
                    dispose: () => { try { shaper.disconnect(); } catch { /* detached */ } },
                };
            }

            case 'delay': {
                // in -> dry -----------------> out
                // in -> delay -> wet --------> out
                //        ^         |
                //        +- feedback
                const input = ctx.createGain();
                const output = ctx.createGain();
                // 5 s is the cap `normalizeEffect` clamps `time` to; a DelayNode throws if asked for more
                // than it was allocated, so the two numbers have to agree.
                const delay = ctx.createDelay(5);
                const feedback = ctx.createGain();
                const wet = ctx.createGain();
                const dry = ctx.createGain();

                input.connect(dry).connect(output);
                input.connect(delay);
                delay.connect(feedback).connect(delay);
                delay.connect(wet).connect(output);

                return {
                    kind: 'delay', in: input, out: output,
                    tune: e => {
                        if (e.kind !== 'delay') return;
                        delay.delayTime.value = e.time;
                        feedback.gain.value = e.feedback;
                        wet.gain.value = e.mix;
                        dry.gain.value = 1 - e.mix;
                    },
                    dispose: () => {
                        for (const n of [input, delay, feedback, wet, dry, output]) {
                            try { n.disconnect(); } catch { /* detached */ }
                        }
                    },
                };
            }

            case 'reverb': {
                // in -> dry ------------------------------> out
                // in -> preDelay -> convolver -> wet -----> out
                const input = ctx.createGain();
                const output = ctx.createGain();
                const preDelay = ctx.createDelay(0.5);
                const convolver = ctx.createConvolver();
                const wet = ctx.createGain();
                const dry = ctx.createGain();

                input.connect(dry).connect(output);
                input.connect(preDelay).connect(convolver).connect(wet).connect(output);

                // The impulse is the expensive part — seconds of noise, generated on the main thread —
                // so it is rebuilt only when `decay` actually moves, not on every mix-slider frame.
                let lastDecay = -1;
                return {
                    kind: 'reverb', in: input, out: output,
                    tune: e => {
                        if (e.kind !== 'reverb') return;
                        if (e.decay !== lastDecay) {
                            convolver.buffer = buildImpulse(ctx, e.decay, 0);
                            lastDecay = e.decay;
                        }
                        // Pre-delay is a real DelayNode rather than silence baked into the impulse, so
                        // moving it is free.
                        preDelay.delayTime.value = e.preDelay;
                        wet.gain.value = e.mix;
                        dry.gain.value = 1 - e.mix;
                    },
                    dispose: () => {
                        for (const n of [input, preDelay, convolver, wet, dry, output]) {
                            try { n.disconnect(); } catch { /* detached */ }
                        }
                    },
                };
            }

            case 'compressor': {
                const comp = ctx.createDynamicsCompressor();
                return {
                    kind: 'compressor', in: comp, out: comp,
                    tune: e => {
                        if (e.kind !== 'compressor') return;
                        comp.threshold.value = e.threshold;
                        comp.knee.value = e.knee;
                        comp.ratio.value = e.ratio;
                        comp.attack.value = e.attack;
                        comp.release.value = e.release;
                    },
                    dispose: () => { try { comp.disconnect(); } catch { /* detached */ } },
                };
            }
        }
        return null;
    }
}
