// Subjects: a value that can be watched. A Subject passes each value it is given to everyone subscribed; a
// ValueSubject also holds the latest one, and a new subscriber is called with it at once — what a health bar wants
// from the health it shows. Channels keep their sticky events in ValueSubjects, and `@observable` fields are one.
//
//   const hp = new ValueSubject(100)
//   const off = hp.subscribe((now, was) => bar.setFill(now / 100))   // called at once with 100
//   hp.value = 80                                                     // and again with (80, 100)
//
// A leaf: imports only within src/core/events.
import { reportListenerError } from './dispatcher';
import { CleoEvent } from './event';

/** Called with each new value (and, from a ValueSubject, the one it replaced). */
export type SubjectObserver<T> = (value: T, previous: T | undefined) => void;

/** A multicast: `next(value)` calls every subscriber with it. A subscriber's throw is reported, and the rest still run. */
export class Subject<T> {
    private _observers: readonly SubjectObserver<T>[] = [];

    /** How many subscribers it has. */
    public get observed(): number { return this._observers.length; }

    /** Call `observer` with every value from now on. Returns the function that stops it. */
    public subscribe(observer: SubjectObserver<T>): () => void {
        this._observers = [...this._observers, observer];
        return () => { this._observers = this._observers.filter(o => o !== observer); };
    }

    /** Pass `value` to every subscriber. */
    public next(value: T, previous?: T): void {
        const observers = this._observers;   // replaced, never changed, by subscribe: safe to walk
        for (let i = 0; i < observers.length; i++) {
            try { observers[i](value, previous); }
            catch (e) { reportListenerError(e, new CleoEvent('subject', 'next', [value, previous]), observers[i]); }
        }
    }

    /** Drop every subscriber. */
    public clear(): void { this._observers = []; }
}

/** A Subject that holds its latest value: a new subscriber is called with it at once. */
export class ValueSubject<T> extends Subject<T> {
    constructor(private _value: T) { super(); }

    /** The latest value. Setting a different one (`!==`) tells every subscriber. */
    public get value(): T { return this._value; }
    public set value(next: T) { this.set(next); }

    /** Set the value; tells subscribers when it changed (`!==`), or always with `force`. Returns whether it changed. */
    public set(next: T, force = false): boolean {
        const previous = this._value;
        if (previous === next && !force) return false;
        this._value = next;
        this.next(next, previous);
        return true;
    }

    public override subscribe(observer: SubjectObserver<T>, replay = true): () => void {
        const off = super.subscribe(observer);
        if (replay) {
            try { observer(this._value, undefined); }
            catch (e) { reportListenerError(e, new CleoEvent('subject', 'replay', [this._value]), observer); }
        }
        return off;
    }
}
