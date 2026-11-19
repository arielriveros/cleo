// Time for NetSync: a scheduler seam (real timers in a game, a manual clock in tests) and the fixed-rate
// ticker the host runs its simulation on (docs/design/netsync.md §5).

/** Where NetSync reads the time and sets its timers. Milliseconds throughout. */
export interface Scheduler {
    /** Monotonic milliseconds (performance.now() in a real game). */
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

/** Real time: `performance.now()` and the platform's timers. */
export const realScheduler: Scheduler = {
    now: () => performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface ManualTask { at: number; seq: number; fn: () => void; }

/**
 * Time that only moves when a test says so. `advance(ms)` runs every timer that falls due, in order, with
 * `now()` reading each timer's own due time — so a test of a 100 ms link is exact and instant. Between
 * timers it lets pending promise callbacks run, because the code under test awaits things.
 */
export class ManualScheduler implements Scheduler {
    private _time: number;
    private _seq = 0;
    private readonly _tasks = new Map<number, ManualTask>();

    constructor(start: number = 0) { this._time = start; }

    public now(): number { return this._time; }

    public setTimeout(fn: () => void, ms: number): unknown {
        const id = ++this._seq;
        this._tasks.set(id, { at: this._time + Math.max(0, ms || 0), seq: id, fn });
        return id;
    }

    public clearTimeout(handle: unknown): void { this._tasks.delete(handle as number); }

    /** Timers not yet run. */
    public get pending(): number { return this._tasks.size; }

    /** Move time forward by `ms`, running everything that falls due on the way. */
    public async advance(ms: number): Promise<void> {
        const end = this._time + ms;
        await settle();
        for (;;) {
            let next: ManualTask | null = null;
            let nextId = 0;
            for (const [id, t] of this._tasks) {
                if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq))) { next = t; nextId = id; }
            }
            if (!next) break;
            this._tasks.delete(nextId);
            this._time = Math.max(this._time, next.at);
            next.fn();
            await settle();
        }
        this._time = end;
        await settle();
    }
}

/** Let queued promise callbacks run (a few rounds, for chains of awaits). */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * Runs `onTick(tick)` at a fixed rate, by deadline rather than by interval: every tick whose time has come
 * runs, then it sleeps until the next one is due. `setInterval` cannot do this — on Windows timers round to
 * ~15.6 ms, so a 33.3 ms interval ran at ~21 Hz in the phase-0 spike.
 *
 * If the host falls further behind than `maxCatchUp` ticks (a stall, a debugger pause), it runs that many
 * and skips the rest, so one slow moment does not become a burst of hundreds of ticks.
 */
export class FixedTicker {
    private _handle: unknown = null;
    private _origin = 0;
    private _next = 0;
    private _skipped = 0;
    private _running = false;

    constructor(
        public readonly rateHz: number,
        private readonly _onTick: (tick: number) => void,
        private readonly _scheduler: Scheduler = realScheduler,
        private readonly _maxCatchUp: number = 5,
    ) {
        if (!(rateHz > 0)) throw new RangeError(`FixedTicker: rate ${rateHz}`);
    }

    public get periodMs(): number { return 1000 / this.rateHz; }
    /** The next tick number to run. */
    public get nextTick(): number { return this._next; }
    /** Ticks dropped because the host fell too far behind. */
    public get skipped(): number { return this._skipped; }
    public get running(): boolean { return this._running; }

    /** Start with tick `firstTick` due now (or at `originMs`, the time tick 0 was due). */
    public start(originMs: number = this._scheduler.now(), firstTick: number = 0): void {
        this.stop();
        this._origin = originMs;
        this._next = firstTick;
        this._running = true;
        this._pump();
    }

    public stop(): void {
        this._running = false;
        if (this._handle !== null) this._scheduler.clearTimeout(this._handle);
        this._handle = null;
    }

    /** The time tick `n` is due. */
    public timeOfTick(n: number): number { return this._origin + (n * 1000) / this.rateHz; }

    private _pump = (): void => {
        this._handle = null;
        if (!this._running) return;
        const now = this._scheduler.now();
        const due = Math.floor(((now - this._origin) * this.rateHz) / 1000 + 1e-9);
        if (due - this._next >= this._maxCatchUp) {
            const skip = due - this._next - this._maxCatchUp + 1;
            this._skipped += skip;
            this._next += skip;
        }
        while (this._running && this._next <= due) this._onTick(this._next++);
        if (!this._running) return;
        this._handle = this._scheduler.setTimeout(this._pump, Math.max(0, this.timeOfTick(this._next) - this._scheduler.now()));
    };
}
