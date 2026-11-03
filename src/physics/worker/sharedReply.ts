import type { Snapshot } from './protocol';

// The physics worker's replies through shared memory, where the page is cross-origin isolated.
//
// A postMessage reply is a TASK on the main thread: the browser runs it only once the thread is free, and a
// thread busy with its frame (scripts, then the render) leaves it waiting there. Measured in the Valley:
// the step took 1.5 ms but the reply arrived 17 ms after its post — exactly when the render ended — and
// was applied 0.2 ms before the next frame began. Any frame that started first (the next frame due at
// once, a CPU-bound frame) found no reply and counted it late. Through a SharedArrayBuffer the main
// thread reads the finished step the moment its frame starts, however busy it was.
//
// One step is in flight at a time and the main thread reads a reply before it posts the next step, so
// the worker never writes while the main thread reads: one region suffices, published by an atomic
// counter (written last by the worker, read first by the main thread).

// Int32 header.
const READY = 0, EPOCH = 1, SEQ = 2, BODY_COUNT = 3, CONTACT_COUNT = 4,
    BODIES_LEN = 5, CONTACTS_LEN = 6, SUBMERGED_LEN = 7, EVENTS_LEN = 8;
const HEADER_INTS = 16;
// Float64 scalars after the header: dt, time, the five stats, and when the worker finished (epoch ms).
const SCALARS = 8;
const DATA_BYTE = HEADER_INTS * 4 + SCALARS * 8;

/** Bytes a snapshot needs in the channel. */
export function sharedReplyBytes(s: Snapshot): number {
    return DATA_BYTE + (s.bodies.length + s.contacts.length + s.submerged.length) * 8
        + s.events.length * 4;
}

/** Shared memory is available here: the page (and so its workers) is cross-origin isolated. */
export function canShareReplies(): boolean {
    return typeof SharedArrayBuffer !== 'undefined'
        && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

/** The worker's end: writes each snapshot and publishes it. */
export class SharedReplyWriter {
    private readonly _header: Int32Array;
    private readonly _scalars: Float64Array;
    private _published = 0;

    constructor(public readonly buffer: SharedArrayBuffer) {
        this._header = new Int32Array(buffer, 0, HEADER_INTS);
        this._scalars = new Float64Array(buffer, HEADER_INTS * 4, SCALARS);
        this._published = Atomics.load(this._header, READY);
    }

    /** Whether `s` fits; a snapshot that does not goes by message, with a bigger channel. */
    public fits(s: Snapshot): boolean { return sharedReplyBytes(s) <= this.buffer.byteLength; }

    public write(s: Snapshot): void {
        const h = this._header, f = this._scalars;
        h[EPOCH] = s.epoch; h[SEQ] = s.seq; h[BODY_COUNT] = s.bodyCount; h[CONTACT_COUNT] = s.contactCount;
        h[BODIES_LEN] = s.bodies.length; h[CONTACTS_LEN] = s.contacts.length; h[SUBMERGED_LEN] = s.submerged.length;
        h[EVENTS_LEN] = s.events.length;
        f[0] = s.dt; f[1] = s.time;
        f[2] = s.stats.stepMs; f[3] = s.stats.broadphaseMs; f[4] = s.stats.narrowphaseMs;
        f[5] = s.stats.solveMs; f[6] = s.stats.integrateMs;
        f[7] = performance.timeOrigin + performance.now();
        let byte = DATA_BYTE;
        for (const a of [s.bodies, s.contacts, s.submerged]) {
            new Float64Array(this.buffer, byte, a.length).set(a);
            byte += a.length * 8;
        }
        new Int32Array(this.buffer, byte, s.events.length).set(s.events);
        // Last, so everything above is visible to a reader that sees the new count.
        Atomics.store(h, READY, ++this._published);
    }
}

/** The main thread's end: a snapshot the worker published since the last read, or null. */
export class SharedReplyReader {
    private readonly _header: Int32Array;
    private readonly _scalars: Float64Array;
    private _read: number;

    constructor(public readonly buffer: SharedArrayBuffer) {
        this._header = new Int32Array(buffer, 0, HEADER_INTS);
        this._scalars = new Float64Array(buffer, HEADER_INTS * 4, SCALARS);
        this._read = Atomics.load(this._header, READY);
    }

    public read(): (Snapshot & { doneAt: number }) | null {
        const ready = Atomics.load(this._header, READY);
        if (ready === this._read) return null;
        this._read = ready;
        const h = this._header, f = this._scalars;
        let byte = DATA_BYTE;
        // Copies (slice allocates an ordinary buffer): the executor keeps and recycles what it is given.
        const f64 = (n: number) => { const a = new Float64Array(this.buffer, byte, n).slice(); byte += n * 8; return a; };
        const i32 = (n: number) => { const a = new Int32Array(this.buffer, byte, n).slice(); byte += n * 4; return a; };
        const bodies = f64(h[BODIES_LEN]), contacts = f64(h[CONTACTS_LEN]), submerged = f64(h[SUBMERGED_LEN]);
        const events = i32(h[EVENTS_LEN]);
        return {
            kind: 'snapshot', epoch: h[EPOCH], seq: h[SEQ], dt: f[0], time: f[1],
            bodies, bodyCount: h[BODY_COUNT], contacts, contactCount: h[CONTACT_COUNT], events, submerged,
            stats: { stepMs: f[2], broadphaseMs: f[3], narrowphaseMs: f[4], solveMs: f[5], integrateMs: f[6] },
            // In this thread's performance.now() clock.
            doneAt: f[7] - performance.timeOrigin,
        };
    }
}
