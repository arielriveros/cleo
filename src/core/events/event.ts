// The Event: what one dispatch carries, from the first listener to the last. Listeners are called with the
// event's arguments, not with this object; a listener that wants it (who sent the event, to stop it travelling
// further, to read what earlier listeners returned) reads `Events.current` while it runs.
//
// A dispatch runs on a DispatchFrame (dispatcher.ts), a pooled record of where it is. The CleoEvent is made only
// when someone asks for it — `Events.current`, or a caller that wants the event back (`publish`) — so an `emit`
// nobody inspects allocates no event at all. While its dispatch runs the event reads and writes through to the
// frame; when the dispatch ends it keeps a copy, and the frame goes back to the pool.
//
// A leaf: imports nothing.

/**
 * Where a node-targeted event is on its way:
 * - `'capture'`: on an ancestor, travelling down to the target (listeners added with `capture: true`);
 * - `'target'`: on the node it was dispatched at;
 * - `'bubble'`: on an ancestor, travelling back up;
 * - `'descend'`: on a node beneath the target, for an event sent DOWN (`dispatchDown`: a command to the animators
 *   under a character);
 * - `'broadcast'`: at the channel's own listeners (`@onEvent`, `Events.on`), which hear it last, from anywhere.
 */
export type EventPhase = 'capture' | 'target' | 'bubble' | 'descend' | 'broadcast';

/** Where one dispatch is. Pooled: never keep one; keep the CleoEvent instead. */
export interface DispatchFrame {
    channel: string;
    name: string;
    args: readonly unknown[];
    target: object | null;
    currentTarget: object | null;
    phase: EventPhase;
    /** What listeners returned, `undefined` left out; made at the first result. */
    results: unknown[] | null;
    stopped: boolean;
    stoppedNow: boolean;
    cancelled: boolean;
    /** The event, once someone asked for it. */
    event: CleoEvent | null;
    /**
     * Scratch for the channel: the target's listening ancestors and their listeners, `[node, emitter, ...]`, in the
     * first `pathLength` slots. Reused by every dispatch at this depth; emptied when the dispatch ends, so it keeps
     * no node alive.
     */
    path: unknown[];
    pathLength: number;
}

const NO_RESULTS: readonly unknown[] = Object.freeze([]);

/** One event being delivered, or delivered. */
export class CleoEvent<Args extends readonly unknown[] = unknown[]> {
    /** @internal The dispatch this event is part of while it runs; null once it is over. */
    public _frame: DispatchFrame | null;
    private _currentTarget: object | null = null;
    private _phase: EventPhase = 'broadcast';
    private _results: unknown[] | null = null;
    private _stopped = false;
    private _stoppedNow = false;
    private _cancelled = false;

    constructor(
        /** The channel it travels on (`'game'`, `'animation'`, `'engine'`, or one a game named). */
        public readonly channel: string,
        /** The event's name within its channel. */
        public readonly name: string,
        /** What listeners are called with. */
        public readonly args: Args,
        /** The node it was dispatched at, or null for a plain broadcast. */
        public readonly target: object | null = null,
        frame: DispatchFrame | null = null,
    ) {
        this._frame = frame;
    }

    /** The first argument: the payload, for an event that carries one value. */
    public get payload(): Args[0] { return this.args[0]; }

    /** `'channel:Name'`. */
    public get qualifiedName(): string { return `${this.channel}:${this.name}`; }

    /** The node the listener being called belongs to: the target, an ancestor, or null at the broadcast. */
    public get currentTarget(): object | null { return this._frame ? this._frame.currentTarget : this._currentTarget; }
    public set currentTarget(value: object | null) { if (this._frame) this._frame.currentTarget = value; else this._currentTarget = value; }

    /** Where the event is on its way (see {@link EventPhase}). */
    public get phase(): EventPhase { return this._frame ? this._frame.phase : this._phase; }
    public set phase(value: EventPhase) { if (this._frame) this._frame.phase = value; else this._phase = value; }

    /** What each listener returned, in call order, `undefined` left out. */
    public get results(): readonly unknown[] {
        return (this._frame ? this._frame.results : this._results) ?? NO_RESULTS;
    }

    /** Stop it travelling on after the current node (or the broadcast): the current node's other listeners still hear it. */
    public stopPropagation(): void { if (this._frame) this._frame.stopped = true; else this._stopped = true; }
    /** Stop it here: no other listener hears it, not even the current node's. */
    public stopImmediatePropagation(): void {
        if (this._frame) { this._frame.stopped = true; this._frame.stoppedNow = true; }
        else { this._stopped = true; this._stoppedNow = true; }
    }
    /** Mark it cancelled, for whoever dispatched it to read (`dispatchEvent(...).cancelled`). Delivery goes on. */
    public cancel(): void { if (this._frame) this._frame.cancelled = true; else this._cancelled = true; }

    public get propagationStopped(): boolean { return this._frame ? this._frame.stopped : this._stopped; }
    public get immediatePropagationStopped(): boolean { return this._frame ? this._frame.stoppedNow : this._stoppedNow; }
    public get cancelled(): boolean { return this._frame ? this._frame.cancelled : this._cancelled; }

    /** @internal Its dispatch is over: keep what the frame says, and let the frame go. */
    public _detach(): void {
        const f = this._frame;
        if (!f) return;
        this._currentTarget = f.currentTarget;
        this._phase = f.phase;
        this._results = f.results;
        this._stopped = f.stopped;
        this._stoppedNow = f.stoppedNow;
        this._cancelled = f.cancelled;
        this._frame = null;
    }
}
