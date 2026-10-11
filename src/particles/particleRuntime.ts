// The CPU half of an emitter: its clock, and how many particles each simulation step spawns and where in
// the pool they go. Everything the GPU cannot decide for itself — and nothing it can.
//
// SPAWNING IS A RING. The pool is a fixed array of slots and every step's newborns take the next
// `count` slots after the previous step's, wrapping. The GPU initializes exactly the slots inside that
// window and integrates every other live one, so there is no free list, no atomic and no readback, and
// the WebGL2 ping-pong (which has no atomics) runs the identical algorithm the WebGPU compute does. The
// cost is the one VFX Graph's capacity also has: an emitter spawning faster than capacity / lifetime
// recycles its oldest particles early. `capacity` is the author's knob for that.
//
// GL-free and deterministic, so it is unit tested: given the same steps it hands out the same windows.

import { mat4, vec3 } from 'gl-matrix';
import { evaluateCurve, type Curve } from './curves';
import { activeModule, maxLifetime, MAX_EMITTER_CAPACITY, type EmitterDef } from './particleSystemAsset';
import type { Burst } from './particleModules';

/** Texels per row of an emitter's state textures. */
export const PARTICLE_TEXTURE_WIDTH = 256;

/**
 * The texture an emitter of `requested` capacity lives in, and the capacity that texture actually holds.
 * Narrow emitters get a one-row texture; wide ones fill whole rows, so capacity is always width x height.
 */
export function particleTextureLayout(requested: number): { width: number; height: number; capacity: number } {
    const want = Math.max(1, Math.floor(requested));
    if (want <= PARTICLE_TEXTURE_WIDTH) {
        // Round small pools up to a multiple of 64 — the compute workgroup — so no dispatch is mostly idle.
        const width = Math.min(PARTICLE_TEXTURE_WIDTH, Math.ceil(want / 64) * 64);
        return { width, height: 1, capacity: width };
    }
    const height = Math.ceil(want / PARTICLE_TEXTURE_WIDTH);
    return { width: PARTICLE_TEXTURE_WIDTH, height, capacity: PARTICLE_TEXTURE_WIDTH * height };
}

/** A sub-emitter's link to its parent, resolved against the emitters actually running. */
export interface SubEmitterLink {
    /** Index of the parent in the system's running emitters. */
    parent: number;
    event: 'death' | 'collision';
    /** Children per parent event, which is also the child-slots-per-parent-slot ratio. */
    count: number;
    inherit: number;
}

/**
 * Resolve every enabled emitter's sub-emitter module against the enabled emitters. A child's pool is
 * sized to its parent's — `count` slots per parent slot — whatever capacity it was authored with: that
 * fixed ownership is what lets the GPU spawn from events without a list. A link to a missing, disabled,
 * or self parent resolves to nothing, and the emitter falls back to ordinary spawning.
 */
export function resolveSubEmitters(defs: readonly EmitterDef[]): { defs: EmitterDef[]; links: (SubEmitterLink | null)[] } {
    const enabled = defs.filter(d => d.enabled);
    const links = enabled.map((d): SubEmitterLink | null => {
        const m = activeModule(d, 'subEmitter');
        if (!m) return null;
        const parent = enabled.findIndex(p => p.id === m.params.parent);
        if (parent < 0 || enabled[parent] === d) return null;
        // A parent that is itself a sub-emitter would need its effective capacity first; one level is
        // what every engine ships, and it keeps this a single pass.
        if (activeModule(enabled[parent], 'subEmitter')) return null;
        return {
            parent, event: m.params.event === 'collision' ? 'collision' : 'death',
            count: Math.max(1, Math.min(8, Math.floor(num(m.params.count, 1)))),
            inherit: num(m.params.inherit, 0),
        };
    });
    const sized = enabled.map((d, i) => {
        const link = links[i];
        if (!link) return d;
        const parentCapacity = particleTextureLayout(enabled[link.parent].capacity).capacity;
        return { ...d, capacity: Math.min(MAX_EMITTER_CAPACITY, parentCapacity * link.count) };
    });
    return { defs: sized, links };
}

/** One GPU simulation step. The renderer turns each into one dispatch (or one ping-pong draw). */
export interface SimStep {
    dt: number;
    /** Seconds since the emitter started playing, at the END of the step. */
    time: number;
    spawnStart: number;
    spawnCount: number;
    /** Particles spawned before this step, ever. Seeds each newborn's random stream. */
    serial: number;
    /** Emitter local-to-world at the start and end of the step; newborns interpolate between them. */
    prevMatrix: mat4;
    matrix: mat4;
    /** World-space emitter velocity over the step, for "inherit velocity". */
    velocity: vec3;
    /** Kill every particle before anything else this step. */
    reset: boolean;
    /**
     * The slots that can hold a live particle after this step: `liveCount` slots ending at the cursor,
     * wrapping. The GPU simulates and draws only these. See {@link EmitterRuntime.liveWindow}.
     */
    liveStart: number;
    liveCount: number;
}

/**
 * Seconds a slot stays in the live window past the longest lifetime. Covers the step a particle is born
 * partway through, and keeps BOTH ping-pong copies of a slot dead before it drops out of the window —
 * a slot outside it is never touched again, so whatever it last held must already be a corpse.
 */
export const LIVE_WINDOW_MARGIN = 0.25;

/** Deterministic 0..1 stream for burst probabilities. mulberry32. */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const num = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

export type EmitterState = 'idle' | 'playing' | 'stopping';

export class EmitterRuntime {
    public readonly capacity: number;
    public readonly width: number;
    public readonly height: number;

    private _state: EmitterState = 'idle';
    /** Seconds since play, delay included. */
    private _time = 0;
    /** Seconds since the last particle could have been born, for {@link isAlive}. */
    private _sinceSpawning = Infinity;
    private _cursor = 0;
    private _serial = 0;
    private _rateCarry = 0;
    private _distanceCarry = 0;
    private _pendingBurst = 0;
    private _pendingReset = false;
    private _random: () => number;
    private readonly _lastMatrix = mat4.create();
    private _hasMatrix = false;
    private _maxLife: number;
    private _def: EmitterDef;
    /** Emitter time that never restarts (`_time` does, on play), for the spawn log. */
    private _clock = 0;
    // The spawn log: when (on `_clock`) and how many slots each recent step handed out, oldest first
    // from `_logHead`. `_logSum` is the total still inside the live window.
    private readonly _logT: number[] = [];
    private readonly _logN: number[] = [];
    private _logHead = 0;
    private _logSum = 0;

    constructor(def: EmitterDef) {
        this._def = def;
        const layout = particleTextureLayout(def.capacity);
        this.capacity = layout.capacity;
        this.width = layout.width;
        this.height = layout.height;
        this._random = rng(def.seed ^ 0x9E3779B9);
        this._maxLife = maxLifetime(def);
    }

    public get def(): EmitterDef { return this._def; }

    /**
     * Swap in an edited definition WITHOUT disturbing live particles or the clock: the authoring path,
     * so tweaking a value keeps the effect running instead of restarting it on every keystroke. Only
     * valid when the pool layout is unchanged; ParticleSystemRuntime.canAdopt decides that.
     */
    public setDef(def: EmitterDef): void {
        this._def = def;
        this._maxLife = maxLifetime(def);
    }

    public get state(): EmitterState { return this._state; }
    public get time(): number { return this._time; }
    public get cursor(): number { return this._cursor; }
    public get serial(): number { return this._serial; }
    /** The longest lifetime a particle of this emitter can be born with. */
    public get maxLife(): number { return this._maxLife; }
    /** Seconds since this emitter last spawned anything (Infinity before it ever has, or after a clear). */
    public get sinceSpawning(): number { return this._sinceSpawning; }

    /**
     * The ring slots that can still hold a live particle: the `count` slots most recently handed out,
     * ending at the cursor. Everything older was born more than a lifetime (plus margin) ago and is dead.
     * Exact from the CPU's own spawn log, no readback, because the ring hands slots out in order.
     */
    public liveWindow(): { start: number; count: number } {
        const count = Math.min(this.capacity, this._logSum);
        return { start: (this._cursor - count + this.capacity) % this.capacity, count };
    }

    private _log(count: number, reset: boolean): void {
        if (reset) {
            this._logT.length = 0;
            this._logN.length = 0;
            this._logHead = 0;
            this._logSum = 0;
        }
        if (count > 0) {
            this._logT.push(this._clock);
            this._logN.push(count);
            this._logSum += count;
        }
        const horizon = this._clock - this._maxLife - LIVE_WINDOW_MARGIN;
        while (this._logHead < this._logT.length && this._logT[this._logHead] < horizon) {
            this._logSum -= this._logN[this._logHead];
            this._logHead++;
        }
        if (this._logHead > 64 && this._logHead * 2 > this._logT.length) {
            this._logT.splice(0, this._logHead);
            this._logN.splice(0, this._logHead);
            this._logHead = 0;
        }
    }

    /** Spawning, or still holding particles that have not yet reached the end of their life. */
    public get isAlive(): boolean {
        return this._state === 'playing' || this._sinceSpawning <= this._maxLife || this._pendingBurst > 0;
    }

    public play(): void {
        if (this._state === 'playing') return;
        this._state = 'playing';
        this._time = 0;
        this._rateCarry = 0;
        this._distanceCarry = 0;
        this._random = rng(this.def.seed ^ 0x9E3779B9);
    }

    /** Stop spawning; live particles finish their lives. */
    public stop(): void {
        if (this._state === 'playing') this._state = 'stopping';
    }

    /** Kill every live particle on the next step. */
    public clear(): void {
        this._pendingReset = true;
        this._sinceSpawning = Infinity;
    }

    /** Spawn `count` extra particles on the next step, on top of the stack's own spawning. */
    public burst(count: number): void {
        this._pendingBurst += Math.max(0, Math.floor(count));
    }

    /**
     * Advance the clock by `dt` and say what the GPU must do for it. `matrix` is the emitter's current
     * local-to-world; `rateScale` multiplies continuous spawning (LOD, the node's spawn-rate scale).
     */
    public advance(dt: number, matrix: mat4, rateScale = 1): SimStep {
        const prev = mat4.clone(this._hasMatrix ? this._lastMatrix : matrix);
        mat4.copy(this._lastMatrix, matrix);
        this._hasMatrix = true;

        const velocity = vec3.create();
        if (dt > 0) {
            velocity[0] = (matrix[12] - prev[12]) / dt;
            velocity[1] = (matrix[13] - prev[13]) / dt;
            velocity[2] = (matrix[14] - prev[14]) / dt;
        }
        const moved = Math.hypot(matrix[12] - prev[12], matrix[13] - prev[13], matrix[14] - prev[14]);

        let count = this._pendingBurst;
        this._pendingBurst = 0;
        if (this._state === 'playing') count += this._spawnBetween(this._time, this._time + dt, moved, rateScale);
        this._time += dt;

        count = Math.min(count, this.capacity);
        const spawnStart = this._cursor;
        this._cursor = (this._cursor + count) % this.capacity;
        const serial = this._serial;
        this._serial = (this._serial + count) % 16777216;   // stays an exact f32 on the GPU
        this._sinceSpawning = count > 0 ? 0 : this._sinceSpawning + dt;

        const reset = this._pendingReset;
        this._pendingReset = false;
        this._clock += dt;
        this._log(count, reset);
        // A reset kills every slot, so that one step must reach every slot.
        const live = reset ? { start: 0, count: this.capacity } : this.liveWindow();
        return { dt, time: this._time, spawnStart, spawnCount: count, serial, prevMatrix: prev,
                 matrix: mat4.clone(matrix), velocity, reset, liveStart: live.start, liveCount: live.count };
    }

    /** Particles born in the interval [t0, t1) of emitter time, delay and cycles accounted for. */
    private _spawnBetween(t0: number, t1: number, moved: number, rateScale: number): number {
        const def = this.def;
        const delay = def.startDelay;
        if (t1 <= delay) return 0;
        const a = Math.max(0, t0 - delay), b = t1 - delay;
        const duration = def.duration;
        // A sub-emitter is born from its parent's events on the GPU; its own timers stay silent.
        if (activeModule(def, 'subEmitter')) return 0;

        let total = 0;
        if (!def.looping && a >= duration) {
            this._state = 'stopping';
            return 0;
        }

        // Walk the interval cycle by cycle, so a burst at the very end of one cycle and the very start of
        // the next both fire even when a long frame straddles the wrap.
        let start = a;
        while (start < b) {
            let cycle = Math.floor(start / duration);
            // At a cycle boundary `start / duration` can round DOWN a cycle, making this piece empty —
            // and the loop would spin forever on it. Such a start belongs to the next cycle.
            // The same expression decides the test and the end, so the two cannot round apart.
            while ((cycle + 1) * duration <= start) cycle++;
            const cycleStart = cycle * duration;
            const end = Math.min(b, (cycle + 1) * duration);
            if (!def.looping && cycle > 0) break;
            total += this._spawnInCycle(start - cycleStart, end - cycleStart, end - start, rateScale);
            start = end;
        }
        if (!def.looping && b >= duration) this._state = 'stopping';

        const rate = activeModule(def, 'spawnRate');
        if (rate) {
            this._distanceCarry += moved * Math.max(0, num(rate.params.perDistance, 0));
            const fromDistance = Math.floor(this._distanceCarry);
            this._distanceCarry -= fromDistance;
            total += fromDistance;
        }
        return total;
    }

    private _spawnInCycle(c0: number, c1: number, dt: number, rateScale: number): number {
        const def = this.def;
        let total = 0;

        const rate = activeModule(def, 'spawnRate');
        if (rate) {
            // The curve at the interval's midpoint: exact for a constant, and within a step's error for
            // anything an author would draw.
            const mid = ((c0 + c1) * 0.5) / def.duration;
            const curve = rate.params.rateOverTime as Curve | undefined;
            const multiplier = curve ? Math.max(0, evaluateCurve(curve, mid)) : 1;
            this._rateCarry += Math.max(0, num(rate.params.rate, 0)) * multiplier * rateScale * dt;
            const whole = Math.floor(this._rateCarry);
            this._rateCarry -= whole;
            total += whole;
        }

        const bursts = activeModule(def, 'spawnBurst');
        if (bursts && Array.isArray(bursts.params.bursts)) {
            for (const burst of bursts.params.bursts as Burst[]) {
                const time = num(burst.time, 0);
                const interval = Math.max(0.01, num(burst.interval, 0.5));
                const cycles = Math.max(0, Math.floor(num(burst.cycles, 1)));
                const probability = Math.min(1, Math.max(0, num(burst.probability, 1)));
                for (let k = 0; cycles === 0 || k < cycles; k++) {
                    const at = time + k * interval;
                    if (at >= def.duration || at >= c1) break;
                    // Half-open [c0, c1), except a burst at exactly t=0 must fire on the very first step.
                    if (at < c0 && !(at === 0 && c0 === 0)) continue;
                    if (probability >= 1 || this._random() < probability)
                        total += Math.max(0, Math.floor(num(burst.count, 0)));
                }
            }
        }
        return total;
    }
}

/** Every emitter of one system instance, plus the steps not yet handed to the GPU. */
export class ParticleSystemRuntime {
    public readonly emitters: EmitterRuntime[];
    /** Per emitter: its sub-emitter parent, or null. */
    public readonly links: (SubEmitterLink | null)[];
    /** Per emitter, oldest first. The renderer drains these once per frame. */
    public readonly pending: SimStep[][];

    /** Steps kept per emitter when nothing drains them (a hidden tab). Older ones are discarded. */
    private static readonly MAX_PENDING = 32;
    /** Steps one frame's {@link advance} may queue per emitter. */
    public static readonly MAX_STEPS_PER_FRAME = 2;
    /** Prewarm steps one frame may run per emitter; the rest wait for the frames after it. */
    public static readonly PREWARM_STEPS_PER_FRAME = 16;
    /** The prewarm's step length. Coarser than a frame step: nobody watches a prewarm integrate. */
    public static readonly PREWARM_STEP = 1 / 20;

    /** Per emitter: prewarm seconds still owed. */
    private readonly _prewarmLeft: number[];
    /** The longest step every emitter stays stable at: tighter when any of them collides. */
    private _maxStep: number;

    constructor(defs: readonly EmitterDef[]) {
        const resolved = resolveSubEmitters(defs);
        this.emitters = resolved.defs.map(d => new EmitterRuntime(d));
        this.links = resolved.links;
        this.pending = this.emitters.map(() => []);
        this._prewarmLeft = this.emitters.map(() => 0);
        this._maxStep = ParticleSystemRuntime._stableStep(resolved.defs);
    }

    private static _stableStep(defs: readonly EmitterDef[]): number {
        // Past 1/30 s a step tunnels through what depth or plane collision is meant to stop. Everything
        // else (drag, noise, forces) stays well-behaved to 1/20 s, which keeps a game running just under
        // 30 fps at one step a frame instead of two.
        return defs.some(d => activeModule(d, 'collision')) ? 1 / 30 : 1 / 20;
    }

    /**
     * Still emitting, or still holding a particle that may be alive. A sub-emitter's particles outlive
     * its own clock: they are born from parent events up to a parent lifetime after the parent stops
     * spawning, and then live their own.
     */
    public get isAlive(): boolean {
        return this.emitters.some((e, i) => {
            if (e.isAlive) return true;
            const link = this.links[i];
            if (!link) return false;
            const parent = this.emitters[link.parent];
            return parent.sinceSpawning <= parent.maxLife + e.maxLife;
        });
    }

    /** Steps queued and not yet run on the GPU, or prewarm still owed. */
    public get hasPendingWork(): boolean {
        return this.pending.some(q => q.length > 0) || this._prewarmLeft.some(t => t > 0);
    }

    /**
     * Whether `defs` can replace the current definitions in place: the same enabled emitters, in the
     * same order, with pools of the same shape in the same space. Anything else needs new GPU state.
     */
    public canAdopt(defs: readonly EmitterDef[]): boolean {
        const resolved = resolveSubEmitters(defs);
        if (resolved.defs.length !== this.emitters.length) return false;
        return resolved.defs.every((d, i) => {
            const e = this.emitters[i];
            const a = resolved.links[i], b = this.links[i];
            return e.def.id === d.id && particleTextureLayout(d.capacity).capacity === e.capacity
                && e.def.simSpace === d.simSpace && (a?.parent ?? -1) === (b?.parent ?? -1);
        });
    }

    /** Replace the definitions in place. Call only after canAdopt. */
    public adopt(defs: readonly EmitterDef[]): void {
        const resolved = resolveSubEmitters(defs);
        resolved.defs.forEach((d, i) => {
            this.emitters[i].setDef(d);
            this.links[i] = resolved.links[i];
        });
        this._maxStep = ParticleSystemRuntime._stableStep(resolved.defs);
    }

    /**
     * Advance every emitter by one frame. `dt` is split into steps no longer than the stable step, each
     * its own GPU step: a large frame time integrated in one go tunnels through colliders and overshoots
     * drag.
     *
     * THE FRAME IS CLAMPED to {@link MAX_STEPS_PER_FRAME} steps, and time past them is dropped: the
     * effect runs slow through a hitch instead of catching up. Catching up is what turned one slow frame
     * into a stagger. Every step is a GPU pass per emitter, so a 100 ms frame queued three times the
     * work for the next frame, which was slow in turn. Engines cap their particle clocks the same way.
     *
     * Prewarm still owed (see {@link prewarm}) runs first, a bounded slice per frame.
     */
    public advance(dt: number, matrix: mat4, rateScale = 1, maxStep = this._maxStep): void {
        this._runPrewarm(matrix);
        if (!(dt > 0)) return;
        const limit = ParticleSystemRuntime.MAX_STEPS_PER_FRAME;
        const span = Math.min(dt, maxStep * limit);
        const steps = Math.min(limit, Math.max(1, Math.ceil(span / maxStep - 1e-9)));
        const h = span / steps;
        for (let s = 0; s < steps; s++)
            for (let i = 0; i < this.emitters.length; i++) this._push(i, this.emitters[i].advance(h, matrix, rateScale));
    }

    /**
     * Run each looping emitter through a cycle so it starts "already going". OWED rather than run here:
     * the steps are real GPU work, and a whole cycle in one frame (96 passes for a 5 s fog) hitched every
     * time an effect started. {@link advance} pays it off over the following frames.
     */
    public prewarm(_matrix?: mat4): void {
        this.emitters.forEach((emitter, i) => {
            if (!emitter.def.prewarm || !emitter.def.looping) return;
            this._prewarmLeft[i] = Math.min(emitter.def.duration, maxLifetime(emitter.def) * 1.5, 10);
        });
    }

    /** Forget prewarm still owed. */
    public cancelPrewarm(): void { this._prewarmLeft.fill(0); }

    private _runPrewarm(matrix: mat4): void {
        for (let i = 0; i < this.emitters.length; i++) {
            let left = this._prewarmLeft[i];
            if (!(left > 0)) continue;
            for (let s = 0; s < ParticleSystemRuntime.PREWARM_STEPS_PER_FRAME && left > 1e-6; s++) {
                const h = Math.min(ParticleSystemRuntime.PREWARM_STEP, left);
                this._push(i, this.emitters[i].advance(h, matrix));
                left -= h;
            }
            this._prewarmLeft[i] = left > 1e-6 ? left : 0;
        }
    }

    /** Take every pending step for emitter `index`. */
    public drain(index: number): SimStep[] {
        const steps = this.pending[index];
        if (!steps || steps.length === 0) return [];
        this.pending[index] = [];
        return steps;
    }

    private _push(index: number, step: SimStep): void {
        const queue = this.pending[index];
        // A prewarm is allowed past the cap — it is one burst of work the very next frame will drain.
        if (queue.length >= ParticleSystemRuntime.MAX_PENDING * 4) queue.shift();
        queue.push(step);
    }
}
