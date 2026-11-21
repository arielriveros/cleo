// The Emitter: one list of listeners per event name, the store every channel and every node target keeps.
//
// Built for the two things a game does to it a lot: deliver (every frame, often), and subscribe and unsubscribe in
// crowds (a wave of a thousand enemies spawning, then despawning). So:
//   - delivery walks the list as it is, allocating nothing;
//   - adding appends (or, with a priority, inserts) in place; only while a delivery is walking the list is it
//     copied first, so a listener added during an event is not called by that event;
//   - removing is O(1): the record is flagged, counted out, and the list compacted later, never while walked.
//     A listener removed during an event is skipped by the rest of that event (the DOM's rule);
//   - an owner's records are indexed, so `removeOwnedBy` touches only them.
//
// A leaf: imports nothing.

/** A listener: called with the event's arguments. What it returns is collected as the event's result. */
export type EventListenerFn = (...args: any[]) => unknown;

/**
 * Narrows which events reach a listener: an object is matched field by field (`===`) against the event's first
 * argument, so `{ team: 'red' }` hears `emit('Died', { team: 'red', ... })` only; a function is called with the
 * event's arguments and the listener runs when it returns true.
 */
export type EventWhere = Readonly<Record<string, unknown>> | ((...args: any[]) => boolean);

/** How a listener listens. Every option is optional. */
export interface ListenOptions {
    /** Called once, then removed. */
    once?: boolean;
    /** Higher runs first; equal priorities run in the order they subscribed. Default 0. */
    priority?: number;
    /** Only events whose arguments match (see {@link EventWhere}). */
    where?: EventWhere;
    /** Who added it: everything one owner added can be removed at once ({@link Emitter.removeOwnedBy}). */
    owner?: object;
    /** On a node target: heard on the way DOWN to the target (capture), before the target's own listeners. */
    capture?: boolean;
    /** On a channel: called at once with the event's last sticky value, if it has one (see `EventChannel.emitSticky`). */
    replay?: boolean;
    /**
     * The engine's own listener, not a script's (an animator listening for the commands sent to it): found by a
     * dispatch like any other, but left out of `hasScriptListeners()`, so the engine's per-frame "does any script
     * listen" gates stay closed when only the engine does.
     */
    system?: boolean;
}

/**
 * One subscription, as the Emitter keeps it. A removed record may sit in its list until the list is compacted, so
 * removal also lets go of everything the record points at — its function (whose closure usually holds a node, or a
 * whole scene), its filter and its owner: a removed listener must never keep anything alive.
 */
export interface ListenerRecord {
    readonly name: string;
    fn: EventListenerFn;
    readonly priority: number;
    readonly once: boolean;
    where: ((args: readonly unknown[]) => boolean) | null;
    owner: object | null;
    readonly capture: boolean;
    readonly system: boolean;
    /** Set when it is taken out, so a delivery still walking the list skips it. */
    removed: boolean;
}

/** What a removed record's function becomes: never called (deliveries skip removed records), and holding nothing. */
const REMOVED: EventListenerFn = () => undefined;

/** One name's listeners. `items` may hold removed records until it is compacted. */
export interface ListenerList {
    items: ListenerRecord[];
    /** Records not removed. */
    live: number;
    /** Of those, the ones that listen in the capture phase. */
    capturing: number;
    /** Removed records still in `items`. */
    dead: number;
    /** Deliveries walking `items` right now: while above 0 it is never changed in place. */
    walking: number;
}

/** Compact a list once this many removed records sit in it, and they outnumber the live ones. */
const COMPACT_AT = 16;

function compileWhere(where: EventWhere | undefined): ((args: readonly unknown[]) => boolean) | null {
    if (!where) return null;
    if (typeof where === 'function') return (args) => !!where(...args);
    const entries = Object.entries(where);
    if (entries.length === 0) return null;
    return (args) => {
        const first = args[0] as Record<string, unknown> | null | undefined;
        if (!first || typeof first !== 'object') return false;
        for (let i = 0; i < entries.length; i++) if (first[entries[i][0]] !== entries[i][1]) return false;
        return true;
    };
}

/** The listener store. `onCount` hears every change in how many listeners a name has (a channel totals them). */
export class Emitter {
    private _lists = new Map<string, ListenerList>();
    private _owned: Map<object, Set<ListenerRecord>> | null = null;
    private _total = 0;

    constructor(private readonly _onCount: ((name: string, delta: number, system: boolean) => void) | null = null) {}

    /** How many listeners `name` has, or all names together. */
    public count(name?: string): number {
        if (name === undefined) return this._total;
        const list = this._lists.get(name);
        return list === undefined ? 0 : list.live;
    }

    /** How many of `name`'s listeners listen in the capture phase. */
    public captureCount(name: string): number {
        const list = this._lists.get(name);
        return list === undefined ? 0 : list.capturing;
    }

    /** The names that have listeners. */
    public names(): string[] {
        const out: string[] = [];
        for (const [name, list] of this._lists) if (list.live > 0) out.push(name);
        return out;
    }

    /** A copy of `name`'s live listeners, highest priority first. For inspection: delivery uses {@link acquire}. */
    public list(name: string): ListenerRecord[] {
        const list = this._lists.get(name);
        return list ? list.items.filter(r => !r.removed) : [];
    }

    /** Whether `fn` listens to `name` (and, if given, with that capture flag). */
    public has(name: string, fn: EventListenerFn, capture?: boolean): boolean {
        const list = this._lists.get(name);
        if (!list) return false;
        for (const r of list.items) if (!r.removed && r.fn === fn && (capture === undefined || r.capture === capture)) return true;
        return false;
    }

    /**
     * `name`'s list, held still for a delivery to walk: nothing changes it in place until {@link release}. Undefined
     * when nothing listens.
     */
    public acquire(name: string): ListenerList | undefined {
        const list = this._lists.get(name);
        if (list === undefined || list.live === 0) return undefined;
        list.walking++;
        return list;
    }

    /** Done walking a list {@link acquire} gave. */
    public release(list: ListenerList): void {
        if (--list.walking > 0) return;
        if (list.live === 0) { this._drop(list); return; }
        if (list.dead >= COMPACT_AT && list.dead > list.live) this._compact(list);
    }

    /** Adds a listener. The same function may listen twice; each subscription is its own record. */
    public add(name: string, fn: EventListenerFn, options: ListenOptions = {}): ListenerRecord {
        if (typeof fn !== 'function') throw new TypeError(`A listener of '${name}' must be a function`);
        const record: ListenerRecord = {
            name,
            fn,
            priority: Number.isFinite(options.priority) ? options.priority! : 0,
            once: !!options.once,
            where: compileWhere(options.where),
            owner: options.owner ?? null,
            capture: !!options.capture,
            system: !!options.system,
            removed: false,
        };
        let list = this._lists.get(name);
        if (list === undefined) { list = { items: [], live: 0, capturing: 0, dead: 0, walking: 0 }; this._lists.set(name, list); }
        // A delivery walking the list keeps the array it is walking: the new listener goes into a copy.
        if (list.walking > 0) { list.items = list.items.slice(); }
        const items = list.items;
        // After every record of the same or a higher priority: equal priorities keep subscription order.
        let at = items.length;
        while (at > 0 && items[at - 1].priority < record.priority) at--;
        if (at === items.length) items.push(record);
        else items.splice(at, 0, record);
        list.live++;
        if (record.capture) list.capturing++;
        this._total++;
        if (record.owner !== null) {
            const owned = this._owned ??= new Map();
            let set = owned.get(record.owner);
            if (!set) { set = new Set(); owned.set(record.owner, set); }
            set.add(record);
        }
        this._onCount?.(name, 1, record.system);
        return record;
    }

    /** Removes one subscription of `fn` to `name` (the earliest). Returns whether there was one. */
    public remove(name: string, fn: EventListenerFn, capture?: boolean): boolean {
        const list = this._lists.get(name);
        if (!list) return false;
        for (const r of list.items)
            if (!r.removed && r.fn === fn && (capture === undefined || r.capture === capture)) return this.removeRecord(r);
        return false;
    }

    /** Removes exactly this subscription. O(1). */
    public removeRecord(record: ListenerRecord): boolean {
        if (record.removed) return false;
        const list = this._lists.get(record.name);
        if (!list) return false;
        record.removed = true;
        list.live--;
        if (record.capture) list.capturing--;
        list.dead++;
        this._total--;
        if (record.owner !== null) {
            const set = this._owned?.get(record.owner);
            if (set) { set.delete(record); if (set.size === 0) this._owned!.delete(record.owner); }
        }
        // The record may linger in the list until it is compacted: it must not keep its listener's world alive.
        record.fn = REMOVED;
        record.where = null;
        record.owner = null;
        this._onCount?.(record.name, -1, record.system);
        if (list.walking === 0) {
            if (list.live === 0) this._drop(list);
            else if (list.dead >= COMPACT_AT && list.dead > list.live) this._compact(list);
        }
        return true;
    }

    /** Removes everything `owner` added. Returns how many. */
    public removeOwnedBy(owner: object): number {
        const set = this._owned?.get(owner);
        if (!set) return 0;
        let removed = 0;
        for (const record of [...set]) if (this.removeRecord(record)) removed++;
        return removed;
    }

    /** Removes every listener (of `name`, or of every name). */
    public clear(name?: string): void {
        const names = name === undefined ? [...this._lists.keys()] : [name];
        for (const n of names) {
            const list = this._lists.get(n);
            if (!list) continue;
            // A copy: removing compacts (or drops) the list as it goes, which would skip records in a live walk.
            for (const record of list.items.slice()) if (!record.removed) this.removeRecord(record);
        }
    }

    /** Drop the removed records, in place: only when no delivery is walking the list. */
    private _compact(list: ListenerList): void {
        const items = list.items;
        let w = 0;
        for (let r = 0; r < items.length; r++) if (!items[r].removed) items[w++] = items[r];
        items.length = w;
        list.dead = 0;
    }

    /** Forget an empty list, unless the name already has a new one. */
    private _drop(list: ListenerList): void {
        const name = list.items[0]?.name;
        if (name !== undefined && this._lists.get(name) === list) this._lists.delete(name);
        else for (const [n, l] of this._lists) if (l === list) { this._lists.delete(n); break; }
    }
}
