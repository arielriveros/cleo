// A Channel: one event bus, publisher and subscriber in one. The Hub (hub.ts) keeps one per name: `game` for what
// scripts send each other, `animation` for what animators fire, `engine` for the engine's own traffic, and any a
// game names. Events of one channel never reach another's listeners (a Broker route can forward them: broker.ts).
//
// Three ways to send, the same listeners for all of them:
//   emit / publish       sync: every listener runs now, inside the call.
//   emitAsync            async: each listener's promise is awaited before the next runs (emitParallel: together).
//   post / defer         deferred: queued, and delivered when the frame flushes the channel (Scene.update).
//
// And to a node: `dispatchAt(node, ...)` travels down to the node (capture), reaches it, travels back up through
// its ancestors (bubble), and ends at the channel's own listeners (broadcast), DOM-style.
//
// What it costs: an emit nobody listens to is a map lookup; one that someone does allocates nothing of its own (see
// dispatcher.ts). A dispatch at a node looks at the node's ancestors only when some node listens to that event.
//
// A leaf: imports only within src/core/events.
import { Emitter, type EventListenerFn, type EventWhere, type ListenOptions, type ListenerList } from './emitter';
import { CleoEvent, type DispatchFrame, type EventPhase } from './event';
import { deliver, deliverAsync, deliverList, eventOf, newFrame, popFrame, pushFrame, reportListenerError } from './dispatcher';
import { countChannelListeners, parentOf, targetCountsFor, targetEmitter, type TargetCounts } from './eventTarget';
import { ValueSubject } from './subject';

/** How a channel behaves. */
export interface ChannelOptions {
    /**
     * Its deferred events wait while the game is paused, as timers do (default true). The engine's channel is not:
     * it flushes every frame, in the editor and while paused.
     */
    pausable?: boolean;
    /**
     * A listener that throws is reported and the others still run (default true). False lets the throw out of the
     * emit, which is how the engine's own bus has always behaved.
     */
    isolateErrors?: boolean;
}

/** How a node-targeted event travels. */
export interface DispatchOptions {
    /** Up through the target's ancestors after the target (default true). False: the target alone, then the broadcast. */
    bubbles?: boolean;
    /** On to the channel's own listeners at the end (default true). False: the node path only. */
    broadcast?: boolean;
}

/** What a deferred event may say about its queueing. */
export interface PostOptions extends DispatchOptions {
    /** Dispatch it at this node when it is delivered. */
    target?: object | null;
    /**
     * At most one event with this key waits in the queue: posting another replaces its arguments (or merges them,
     * with `merge`). For "this changed" events, so a thing that changes a hundred times a frame is told once.
     */
    coalesce?: unknown;
    /** Combine a coalesced event's queued arguments with the new ones. Default: the new ones win. */
    merge?: (queued: unknown[], next: unknown[]) => unknown[];
}

/** How {@link EventChannel.next} waits. */
export interface NextOptions {
    /** Only an event whose arguments match. */
    where?: EventWhere;
    /** Give up after this many milliseconds (real time): the promise rejects. */
    timeout?: number;
}

/** A deferred event waiting for its channel's flush. */
export interface QueuedEvent {
    readonly name: string;
    args: unknown[];
    readonly target: object | null;
    readonly options: DispatchOptions | undefined;
    /** Its coalescing key, if it has one. */
    readonly key: unknown;
}

/** Deferred events one channel holds before it warns and drops: a queue no frame ever flushes. */
const MAX_QUEUED = 50_000;

export class EventChannel {
    /** The channel's own (broadcast) listeners: `@onEvent`, `Events.on`, `channel.on`. */
    public readonly listeners: Emitter;
    public readonly pausable: boolean;
    public readonly isolateErrors: boolean;

    /** This channel's node-target listener counts (eventTarget.ts), held so asking costs no lookup by channel. */
    private readonly _targets: TargetCounts;

    private _queue: QueuedEvent[] = [];
    private readonly _coalesced = new Map<unknown, QueuedEvent>();
    private readonly _sticky = new Map<string, ValueSubject<unknown[] | undefined>>();
    private _warnedFull = false;

    /**
     * @param counted Whether its listeners count towards `hasScriptListeners` (the hub's channels do; a channel made
     * on its own, outside the hub, is nobody's business but its maker's).
     */
    constructor(public readonly name: string, options: ChannelOptions = {}, counted = false) {
        this.pausable = options.pausable !== false;
        this.isolateErrors = options.isolateErrors !== false;
        this.listeners = new Emitter(counted ? (_event, delta) => countChannelListeners(name, delta) : null);
        this._targets = targetCountsFor(name);
    }

    /** How many node-target listeners `name` has on this channel (all of them, without a name). */
    private _targetCount(name?: string): number {
        const t = this._targets;
        if (t.total === 0 || name === undefined) return t.total;
        return t.byName.get(name) ?? 0;
    }

    // ---- listening ---------------------------------------------------------------------------------------------

    /**
     * Whether anyone listens to `name` (or, without one, to anything) on this channel: its own listeners or any
     * node's. O(1): callers on hot paths ask before building an event's arguments.
     */
    public hasListeners(name?: string): boolean {
        return this.listeners.count(name) > 0 || this._targetCount(name) > 0;
    }

    /** Listen to `name`. Returns the function that stops listening. */
    public on(name: string, fn: EventListenerFn, options?: ListenOptions): () => void {
        const record = this.listeners.add(name, fn, options);
        if (options?.replay) {
            const sticky = this._sticky.get(name)?.value;
            if (sticky) this._replay(name, fn, sticky);
        }
        return () => { this.listeners.removeRecord(record); };
    }

    /** Listen to `name` once. Returns the function that stops listening before it fires. */
    public once(name: string, fn: EventListenerFn, options?: ListenOptions): () => void {
        return this.on(name, fn, { ...options, once: true });
    }

    /** Stop `fn` listening to `name`. Returns whether it was. */
    public off(name: string, fn: EventListenerFn): boolean {
        return this.listeners.remove(name, fn);
    }

    /** Remove every listener `owner` added to this channel. */
    public removeOwnedBy(owner: object): number {
        return this.listeners.removeOwnedBy(owner);
    }

    // ---- sync -----------------------------------------------------------------------------------------------------

    /** Call every listener of `name` with `args`, now. Returns whether there was one. */
    public emit(name: string, ...args: unknown[]): boolean;
    public emit(name: string): boolean {
        // `arguments`, not a rest parameter: an emit nobody listens to builds no argument array.
        const list = this.listeners.acquire(name);
        if (list === undefined) return false;
        const count = arguments.length - 1;
        let args: unknown[];
        if (count === 1) args = [arguments[1]];
        else if (count === 0) args = [];
        else if (count === 2) args = [arguments[1], arguments[2]];
        else { args = []; for (let i = 1; i <= count; i++) args.push(arguments[i]); }
        this._broadcast(list, name, args);
        return true;
    }

    /** Call every listener of `name` with the one `payload`, now: `emit(name, payload)` without its argument list. */
    public emitOne(name: string, payload: unknown): boolean {
        const list = this.listeners.acquire(name);
        if (list === undefined) return false;
        this._broadcast(list, name, [payload]);
        return true;
    }

    /** Call every listener of `name` with `args` (an array the caller made), now. Returns whether there was one. */
    public emitArgs(name: string, args: readonly unknown[]): boolean {
        const list = this.listeners.acquire(name);
        if (list === undefined) return false;
        this._broadcast(list, name, args);
        return true;
    }

    /** Deliver to the channel's own listeners, from a list already acquired. */
    private _broadcast(list: ListenerList, name: string, args: readonly unknown[]): void {
        const frame = pushFrame(this.name, name, args, null);
        if (frame === null) { this.listeners.release(list); return; }
        try { deliverList(this.listeners, list, frame, this.isolateErrors); }
        finally { popFrame(); }
    }

    /**
     * Deliver `name` now (at `target`, if given), keeping nothing: the fast form of {@link publish}, for callers
     * that do not read the event back. Allocates no event unless a listener asks for `Events.current`.
     */
    public fire(name: string, args: readonly unknown[], target: object | null, options?: DispatchOptions): void {
        if (target === null || this._targetCount(name) === 0) {
            // The common case, a broadcast: straight to the channel's own listeners.
            if (options?.broadcast === false) return;
            const list = this.listeners.acquire(name);
            if (list === undefined) return;
            if (target === null) { this._broadcast(list, name, args); return; }
            const frame = pushFrame(this.name, name, args, target);
            if (frame === null) { this.listeners.release(list); return; }
            try { frame.phase = 'broadcast'; deliverList(this.listeners, list, frame, this.isolateErrors); }
            finally { popFrame(); }
            return;
        }
        const frame = pushFrame(this.name, name, args, target);
        if (frame === null) return;
        try { this._travel(frame, options); }
        finally { popFrame(); }
    }

    /** As {@link emit}, returning the event: its `results`, and whether a listener cancelled it. */
    public publish(name: string, args: unknown[] = [], target: object | null = null, options?: DispatchOptions): CleoEvent {
        if (!this._reaches(name, target)) return new CleoEvent(this.name, name, args, target);
        const frame = pushFrame(this.name, name, args, target);
        if (frame === null) return new CleoEvent(this.name, name, args, target);
        const event = eventOf(frame);
        try { this._travel(frame, options); }
        finally { popFrame(); }
        return event;
    }

    /** Dispatch at `target`: capture down to it, the target, bubble back up, then the broadcast. */
    public dispatchAt(target: object, name: string, args: unknown[] = [], options?: DispatchOptions): CleoEvent {
        return this.publish(name, args, target, options);
    }

    /** The first result a listener of `name` returns for `args` (`undefined` results skipped), or undefined. */
    public request(name: string, ...args: unknown[]): unknown {
        if (this.listeners.count(name) === 0) return undefined;
        return this.publish(name, args).results[0];
    }

    // ---- async ----------------------------------------------------------------------------------------------------

    /** Call the listeners of `name` one after another, awaiting each one's promise. Resolves to their results. */
    public async emitAsync(name: string, ...args: unknown[]): Promise<unknown[]> {
        return [...(await this.publishAsync(name, args)).results];
    }

    /** Call every listener of `name` at once and await them all. Resolves to their results, in call order. */
    public async emitParallel(name: string, ...args: unknown[]): Promise<unknown[]> {
        return [...(await this.publishAsync(name, args, null, { parallel: true })).results];
    }

    /** As {@link request}, awaiting the listeners. */
    public async requestAsync(name: string, ...args: unknown[]): Promise<unknown> {
        if (this.listeners.count(name) === 0) return undefined;
        return (await this.publishAsync(name, args)).results[0];
    }

    /** The async form of {@link publish} / {@link dispatchAt}. */
    public async publishAsync(name: string, args: unknown[] = [], target: object | null = null, options: DispatchOptions & { parallel?: boolean } = {}): Promise<CleoEvent> {
        if (!this._reaches(name, target)) return new CleoEvent(this.name, name, args, target);
        const frame = newFrame(this.name, name, args, target);
        const event = eventOf(frame);
        const parallel = !!options.parallel;
        try {
            const stops: [object, EventPhase][] = [];
            if (target !== null && this._targetCount(name) > 0) {
                const path = this._ancestors(target, name);
                if (path) for (let i = path.length - 2; i >= 0; i -= 2) stops.push([path[i], 'capture']);
                stops.push([target, 'target']);
                if (path && options.bubbles !== false) for (let i = 0; i < path.length; i += 2) stops.push([path[i], 'bubble']);
            }
            for (const [node, phase] of stops) {
                const emitter = targetEmitter(node, this.name);
                if (!emitter || emitter.count(name) === 0) continue;
                frame.phase = phase;
                frame.currentTarget = node;
                await deliverAsync(emitter, name, frame, this.isolateErrors, parallel);
                if (frame.stopped) return event;
            }
            if (options.broadcast !== false && this.listeners.count(name) > 0) {
                frame.phase = 'broadcast';
                frame.currentTarget = null;
                await deliverAsync(this.listeners, name, frame, this.isolateErrors, parallel);
            }
            return event;
        } finally {
            event._detach();
        }
    }

    /** Resolves with the first argument of the next `name` event (that matches `where`). */
    public next(name: string, options: NextOptions = {}): Promise<unknown> {
        return new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const off = this.on(name, (...args: unknown[]) => {
                if (timer !== null) clearTimeout(timer);
                resolve(args[0]);
            }, { once: true, where: options.where });
            if (options.timeout !== undefined && options.timeout >= 0) {
                timer = setTimeout(() => { off(); reject(new Error(`No '${this.name}:${name}' event within ${options.timeout} ms`)); }, options.timeout);
            }
        });
    }

    // ---- deferred -----------------------------------------------------------------------------------------------

    /** Queue `name` with `args` for the channel's next flush (the frame's event phase). */
    public post(name: string, ...args: unknown[]): void {
        this.defer(name, args);
    }

    /** Queue an event with options: a target to dispatch at, a coalescing key. */
    public defer(name: string, args: unknown[] = [], options: PostOptions = {}): void {
        const key = options.coalesce;
        if (key !== undefined) {
            const queued = this._coalesced.get(key);
            if (queued) {
                queued.args = options.merge ? options.merge(queued.args, args) : args;
                return;
            }
        }
        if (this._queue.length >= MAX_QUEUED) {
            if (!this._warnedFull) {
                this._warnedFull = true;
                reportListenerError(new Error(`The '${this.name}' channel has ${MAX_QUEUED} deferred events waiting and nothing flushing them: dropping new ones`), new CleoEvent(this.name, name, args), () => undefined);
            }
            return;
        }
        const entry: QueuedEvent = {
            name, args, target: options.target ?? null, key,
            options: options.bubbles === undefined && options.broadcast === undefined ? undefined : { bubbles: options.bubbles, broadcast: options.broadcast },
        };
        this._queue.push(entry);
        if (key !== undefined) this._coalesced.set(key, entry);
    }

    /** The arguments of the event queued under coalescing `key`, to fold into in place; undefined if none waits. */
    public queuedArgs(key: unknown): unknown[] | undefined {
        return this._coalesced.get(key)?.args;
    }

    /** How many deferred events wait. */
    public get queued(): number { return this._queue.length; }

    /**
     * Drop the waiting events `drop` says to (those about nodes of a scene being disposed, say). Returns how many.
     */
    public discard(drop: (event: QueuedEvent) => boolean): number {
        if (this._queue.length === 0) return 0;
        const kept: QueuedEvent[] = [];
        for (const entry of this._queue) {
            if (!drop(entry)) { kept.push(entry); continue; }
            if (entry.key !== undefined && this._coalesced.get(entry.key) === entry) this._coalesced.delete(entry.key);
        }
        const dropped = this._queue.length - kept.length;
        this._queue = kept;
        return dropped;
    }

    /**
     * Deliver every deferred event, in the order they were posted. One posted while this runs waits for the next
     * flush, so a listener that posts what it hears cannot hold the frame. Returns how many were delivered.
     */
    public flush(): number {
        if (this._queue.length === 0) return 0;
        const queue = this._queue;
        this._queue = [];
        this._coalesced.clear();
        this._warnedFull = false;
        for (const entry of queue) {
            // The frame loop drives this: a throw from a channel that does not isolate is reported, not let out.
            try { this.fire(entry.name, entry.args, entry.target, entry.options); }
            catch (e) { reportListenerError(e, new CleoEvent(this.name, entry.name, entry.args, entry.target), () => undefined); }
        }
        return queue.length;
    }

    // ---- sticky -----------------------------------------------------------------------------------------------------

    /**
     * Emit `name` and keep its arguments: a listener added later with `replay: true` is called with them at once.
     * For states rather than moments — "the level is loaded", "the boss is awake".
     */
    public emitSticky(name: string, ...args: unknown[]): boolean {
        let subject = this._sticky.get(name);
        if (!subject) { subject = new ValueSubject<unknown[] | undefined>(undefined); this._sticky.set(name, subject); }
        subject.set(args, true);
        return this.emit(name, ...args);
    }

    /** The arguments `name` was last sticky-emitted with, or undefined. */
    public sticky(name: string): unknown[] | undefined {
        return this._sticky.get(name)?.value;
    }

    /** Forget a sticky event (or all of them). */
    public clearSticky(name?: string): void {
        if (name === undefined) this._sticky.clear();
        else this._sticky.delete(name);
    }

    // ---- lifetime ---------------------------------------------------------------------------------------------------

    /** Drop the channel's own listeners, its queue and its sticky values. Node-target listeners go with their nodes. */
    public clear(): void {
        this.listeners.clear();
        this._queue = [];
        this._coalesced.clear();
        this._sticky.clear();
        this._warnedFull = false;
    }

    // ---- internals --------------------------------------------------------------------------------------------------

    /** Whether a dispatch of `name` (at `target`, if given) can reach anyone at all. */
    private _reaches(name: string, target: object | null): boolean {
        return this.listeners.count(name) > 0 || (target !== null && this._targetCount(name) > 0);
    }

    /**
     * `target`'s ancestors that listen to `name` on this channel, nearest first, each followed by its listeners:
     * `[node, emitter, node, emitter, ...]`. Null when none does.
     */
    private _ancestors(target: object, name: string): (object | Emitter)[] | null {
        let path: (object | Emitter)[] | null = null;
        for (let n = parentOf(target); n !== null; n = parentOf(n)) {
            const emitter = targetEmitter(n, this.name);
            if (emitter !== undefined && emitter.count(name) > 0) (path ??= []).push(n, emitter);
        }
        return path;
    }

    /** As {@link _ancestors}, into the frame's scratch path: returns how many slots it filled (two per ancestor). */
    private _ancestorsInto(frame: DispatchFrame, target: object, name: string): number {
        const path = frame.path;
        let length = 0;
        for (let n = parentOf(target); n !== null; n = parentOf(n)) {
            const emitter = targetEmitter(n, this.name);
            if (emitter !== undefined && emitter.count(name) > 0) { path[length++] = n; path[length++] = emitter; }
        }
        frame.pathLength = length;
        return length;
    }

    private _travel(frame: DispatchFrame, options?: DispatchOptions): void {
        const name = frame.name;
        const target = frame.target;
        if (target !== null && this._targetCount(name) > 0) {
            // Ancestors are walked only when some node listens to this very event, and only those that do are kept.
            const length = this._ancestorsInto(frame, target, name);
            const path = frame.path;
            // Each ancestor is visited on the way down only if it has capture listeners, and on the way up only if
            // it has others.
            for (let i = length - 2; i >= 0; i -= 2) {
                const emitter = path[i + 1] as Emitter;
                if (emitter.captureCount(name) > 0 && this._at(path[i] as object, emitter, 'capture', frame)) return;
            }
            const own = targetEmitter(target, this.name);
            if (own !== undefined && own.count(name) > 0 && this._at(target, own, 'target', frame)) return;
            if (options?.bubbles !== false) for (let i = 0; i < length; i += 2) {
                const emitter = path[i + 1] as Emitter;
                if (emitter.count(name) > emitter.captureCount(name) && this._at(path[i] as object, emitter, 'bubble', frame)) return;
            }
        }
        if (options?.broadcast === false || this.listeners.count(name) === 0) return;
        frame.phase = 'broadcast';
        frame.currentTarget = null;
        deliver(this.listeners, name, frame, this.isolateErrors);
    }

    /** Deliver at one node of the path. Returns true when the event was stopped there. */
    private _at(node: object, emitter: Emitter, phase: 'capture' | 'target' | 'bubble', frame: DispatchFrame): boolean {
        frame.phase = phase;
        frame.currentTarget = node;
        deliver(emitter, frame.name, frame, this.isolateErrors);
        return frame.stopped;
    }

    private _replay(name: string, fn: EventListenerFn, args: unknown[]): void {
        try { fn(...args); }
        catch (e) {
            if (!this.isolateErrors) throw e;
            reportListenerError(e, new CleoEvent(this.name, name, args), fn);
        }
    }
}
