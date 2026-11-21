// The Dispatcher: how an event reaches the listeners of one list. Every channel and node target delivers through
// these, so the rules are the same everywhere:
//
//   sync      deliver()        listeners run now, inside the emit, highest priority first; results come back.
//   async     deliverAsync()   each listener's returned promise is awaited before the next one runs (or all run
//                              together with `parallel`); the caller gets a promise of the results.
//   deferred  (EventChannel.post) queued and delivered by deliver() at the frame's flush.
//
// A sync dispatch runs on a pooled DispatchFrame, one per nesting depth, so delivering an event allocates nothing of
// its own: no event object unless someone asks for one (`Events.current`, `publish`), no results array unless a
// listener returns something.
//
// A listener that throws (or returns a promise that rejects) is reported through the error reporter and the rest
// still run — unless the channel does not isolate errors (the engine channel, whose listeners are the engine's
// and editor's own code and have always propagated).
//
// A leaf: imports only within src/core/events.
import { CleoEvent, type DispatchFrame } from './event';
import type { Emitter, EventListenerFn, ListenerList, ListenerRecord } from './emitter';

/** Told about a listener that threw, or whose promise rejected. */
export type EventErrorReporter = (error: unknown, event: CleoEvent, listener: EventListenerFn) => void;

let reporter: EventErrorReporter = (error, event) => {
    // The scripting layer replaces this with the console's script error line (setEventErrorReporter).
    console.error(`[events] a listener of '${event.qualifiedName}' failed:`, error);
};

/** Replace how listener failures are reported. Returns the reporter it replaced. */
export function setEventErrorReporter(next: EventErrorReporter): EventErrorReporter {
    const previous = reporter;
    reporter = next;
    return previous;
}

/** Set while the reporter runs: what it does (log a line, which is itself an event) must not report into itself. */
let reporting = false;

export function reportListenerError(error: unknown, event: CleoEvent, listener: EventListenerFn): void {
    if (reporting) {
        console.error(`[events] a listener of '${event.qualifiedName}' failed while another failure was being reported:`, error);
        return;
    }
    reporting = true;
    try { reporter(error, event, listener); }
    catch { /* a reporter that throws must not take the dispatch down with it */ }
    finally { reporting = false; }
}

// ---- frames ---------------------------------------------------------------------------------------------------

/** An event emitted from its own listener, again and again, is a loop: past this depth it is dropped and reported. */
export const MAX_EVENT_DEPTH = 32;

/** The dispatches running now, innermost last: `stack[depth - 1]` is the one whose listener is being called. */
const stack: DispatchFrame[] = [];
/** One reusable frame per depth, for sync dispatches. */
const pool: DispatchFrame[] = [];
let depth = 0;

function blankFrame(): DispatchFrame {
    return { channel: '', name: '', args: [], target: null, currentTarget: null, phase: 'broadcast', results: null, stopped: false, stoppedNow: false, cancelled: false, event: null, path: [], pathLength: 0 };
}

/** A fresh frame not from the pool: an async dispatch's, which outlives the call that started it. */
export function newFrame(channel: string, name: string, args: readonly unknown[], target: object | null): DispatchFrame {
    const f = blankFrame();
    f.channel = channel; f.name = name; f.args = args; f.target = target;
    return f;
}

/**
 * Start a sync dispatch: the pooled frame for this depth, or null (reported) when the dispatch is nested too deep.
 * Every frame pushed must be popped, in a `finally`.
 */
export function pushFrame(channel: string, name: string, args: readonly unknown[], target: object | null): DispatchFrame | null {
    if (depth >= MAX_EVENT_DEPTH) {
        const event = new CleoEvent(channel, name, args as unknown[], target);
        reportListenerError(new Error(`'${event.qualifiedName}' was dispatched ${MAX_EVENT_DEPTH} levels deep inside its own listeners: dropped (a listener that re-emits what it hears is a loop)`), event, () => undefined);
        return null;
    }
    const f = pool[depth] ??= blankFrame();
    f.channel = channel; f.name = name; f.args = args; f.target = target;
    f.currentTarget = null; f.phase = 'broadcast'; f.results = null;
    f.stopped = false; f.stoppedNow = false; f.cancelled = false; f.event = null;
    stack[depth++] = f;
    return f;
}

/** End the innermost sync dispatch: its event (if one was made) keeps a copy, and the frame is free again. */
export function popFrame(): void {
    const f = stack[--depth];
    stack[depth] = undefined as unknown as DispatchFrame;
    if (f.event) { f.event._detach(); f.event = null; }
    f.args = EMPTY_ARGS; f.target = null; f.currentTarget = null; f.results = null;
    if (f.pathLength > 0) {
        const path = f.path;
        for (let i = 0; i < f.pathLength; i++) path[i] = undefined;
        f.pathLength = 0;
    }
}

const EMPTY_ARGS: readonly unknown[] = Object.freeze([]);

/** The frame's event, made now if nobody asked for it before. */
export function eventOf(frame: DispatchFrame): CleoEvent {
    return frame.event ??= new CleoEvent(frame.channel, frame.name, frame.args as unknown[], frame.target, frame);
}

/** The event whose listener is running right now, or null. Valid only during the listener's synchronous part. */
export function currentEvent(): CleoEvent | null {
    return depth === 0 ? null : eventOf(stack[depth - 1]);
}

// ---- delivery -------------------------------------------------------------------------------------------------

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return !!value && (typeof value === 'object' || typeof value === 'function') && typeof (value as any).then === 'function';
}

/** Call a listener with the event's arguments, without a spread for the usual few. */
function call(fn: EventListenerFn, args: readonly unknown[]): unknown {
    switch (args.length) {
        case 0: return fn();
        case 1: return fn(args[0]);
        case 2: return fn(args[0], args[1]);
        case 3: return fn(args[0], args[1], args[2]);
        default: return fn(...args);
    }
}

/**
 * Whether a record hears this event in this phase. At the target both capture and bubble listeners hear it; on an
 * ancestor, capture listeners hear the way down and the others the way up; at the broadcast, everyone.
 */
function inPhase(record: ListenerRecord, phase: DispatchFrame['phase']): boolean {
    // Sent down ('descend'), every listener at a node hears it, as at the target.
    return phase === 'capture' ? record.capture : phase === 'bubble' ? !record.capture : true;
}

/**
 * Deliver the frame's event to the listeners `name` has in `emitter`, now, in the frame's phase. Stops early when a
 * listener stops the event immediately. A `once` record is removed before its call, so an emit from inside it
 * cannot reach it again.
 */
export function deliver(emitter: Emitter, name: string, frame: DispatchFrame, isolate: boolean): void {
    const list = emitter.acquire(name);
    if (list !== undefined) deliverList(emitter, list, frame, isolate);
}

/** As {@link deliver}, for a list the caller has already acquired (it is released here). */
export function deliverList(emitter: Emitter, list: ListenerList, frame: DispatchFrame, isolate: boolean): void {
    const items = list.items;
    const length = items.length;   // a listener added during this delivery is not called by it
    const phase = frame.phase;
    const args = frame.args;
    // Which listeners the phase leaves out: capture ones on the way up, the others on the way down.
    const skipCapture = phase === 'bubble';
    const skipBubble = phase === 'capture';
    try {
        for (let i = 0; i < length; i++) {
            const record = items[i];
            if (record.removed || (record.capture ? skipCapture : skipBubble)) continue;
            if (record.where !== null && !record.where(args)) continue;
            // Read before a `once` record is removed: removal clears it, so it holds nothing alive.
            const fn = record.fn;
            if (record.once) emitter.removeRecord(record);
            let result: unknown;
            try { result = call(fn, args); }
            catch (e) {
                if (!isolate) throw e;
                reportListenerError(e, eventOf(frame), fn);
                if (frame.stoppedNow) return;
                continue;
            }
            if (result !== undefined) {
                (frame.results ??= []).push(result);
                if (isolate && isThenable(result)) {
                    const event = eventOf(frame);
                    (result as Promise<unknown>).then(undefined, (e: unknown) => reportListenerError(e, event, fn));
                }
            }
            if (frame.stoppedNow) return;
        }
    } finally {
        emitter.release(list);
    }
}

/**
 * Deliver an async dispatch's event to the listeners `name` has in `emitter`, awaiting each listener's promise before
 * calling the next (or calling them all and awaiting them together with `parallel`). Each listener's synchronous
 * part runs with the frame current, so `Events.current` works there.
 */
export async function deliverAsync(emitter: Emitter, name: string, frame: DispatchFrame, isolate: boolean, parallel: boolean): Promise<void> {
    const list = emitter.acquire(name);
    if (list === undefined) return;
    const items = list.items;
    const length = items.length;
    const phase = frame.phase;
    const pending: { fn: EventListenerFn; value: Promise<unknown> }[] = [];
    try {
        for (let i = 0; i < length; i++) {
            const record = items[i];
            if (record.removed || !inPhase(record, phase)) continue;
            if (record.where !== null && !record.where(frame.args)) continue;
            const fn = record.fn;
            if (record.once) emitter.removeRecord(record);
            let value: Promise<unknown>;
            stack[depth++] = frame;
            try { value = Promise.resolve(call(fn, frame.args)); }
            catch (e) { value = Promise.reject(e); }
            finally { stack[--depth] = undefined as unknown as DispatchFrame; }
            if (parallel) { pending.push({ fn, value }); continue; }
            try {
                const result = await value;
                if (result !== undefined) (frame.results ??= []).push(result);
            } catch (e) {
                if (!isolate) throw e;
                reportListenerError(e, eventOf(frame), fn);
            }
            if (frame.stoppedNow) return;
        }
    } finally {
        emitter.release(list);
    }
    if (!parallel) return;
    const settled = await Promise.allSettled(pending.map(p => p.value));
    for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        if (s.status === 'fulfilled') { if (s.value !== undefined) (frame.results ??= []).push(s.value); continue; }
        if (!isolate) throw s.reason;
        reportListenerError(s.reason, eventOf(frame), pending[i].fn);
    }
}
