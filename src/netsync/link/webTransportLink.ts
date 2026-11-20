// A NetLink over WebTransport (docs/design/netsync.md §4.2). The same wrapper serves both ends: in the browser
// it wraps the page's `WebTransport`, on the host a session from the Node WebTransport library, which has the
// same shape. The only difference is who opens the control stream — the peer does.
//
//   control → the first bidirectional stream, messages framed `u32 length | payload`
//   pulse   → datagrams
//   bulk    → one unidirectional stream per message, read to its end

import { LinkBase, PULSE_BUDGET, concatBytes, frame, frameReader, type LinkKind } from './netLink';

type Bytes = Uint8Array;
interface BidiStream { readable: ReadableStream<Bytes>; writable: WritableStream<Bytes>; }

/**
 * The parts of a WebTransport this link uses — the browser's object and the Node library's session both
 * fit. Datagram writing is spelled two ways: the current spec's `createWritable()` (WebKit, the Node
 * library) and the older `writable` (Chromium, Firefox); each engine has only one of them.
 */
export interface WebTransportLike {
    readonly ready: Promise<unknown>;
    readonly closed: Promise<unknown>;
    readonly datagrams: {
        readonly readable: ReadableStream<Bytes>;
        readonly writable?: WritableStream<Bytes>;
        createWritable?(): WritableStream<Bytes>;
        readonly maxDatagramSize?: number;
    };
    createBidirectionalStream(): Promise<BidiStream>;
    readonly incomingBidirectionalStreams: ReadableStream<BidiStream>;
    createUnidirectionalStream(): Promise<WritableStream<Bytes>>;
    readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Bytes>>;
    close(info?: { closeCode?: number; reason?: string }): void;
}

/** Which datagram API a link ended up writing with (reported by the phase-0 probe and the debugger). */
export type DatagramWriterKind = 'createWritable' | 'writable' | 'none';

export class WebTransportLink extends LinkBase {
    public readonly kind: LinkKind = 'webtransport';
    public readonly pulseBudget: number;
    public readonly datagramWriter: DatagramWriterKind;
    private readonly _controlWriter: WritableStreamDefaultWriter<Bytes>;
    private readonly _datagramWriter: WritableStreamDefaultWriter<Bytes> | null;

    private constructor(private readonly _wt: WebTransportLike, control: BidiStream) {
        super();
        const max = _wt.datagrams.maxDatagramSize;
        this.pulseBudget = typeof max === 'number' && max > 0 ? Math.min(PULSE_BUDGET, max) : PULSE_BUDGET;

        let writable: WritableStream<Bytes> | null = null;
        let writer: DatagramWriterKind = 'none';
        if (typeof _wt.datagrams.createWritable === 'function') {
            try { writable = _wt.datagrams.createWritable(); writer = 'createWritable'; } catch { /* fall through */ }
        }
        if (!writable && _wt.datagrams.writable) { writable = _wt.datagrams.writable; writer = 'writable'; }
        this.datagramWriter = writer;
        this._datagramWriter = writable ? writable.getWriter() : null;
        this._controlWriter = control.writable.getWriter();

        _wt.closed.then(
            (info: any) => this._markClosed(info?.reason || 'closed'),
            (e: any) => this._markClosed(`lost: ${e?.message ?? e}`),
        );
        this._readControl(control.readable);
        this._readDatagrams();
        this._readBulk();
    }

    /**
     * Wrap a WebTransport whose `ready` has resolved. A peer opens the control stream; a host waits (up to
     * `controlTimeoutMs`) for the peer's.
     */
    public static async open(wt: WebTransportLike, role: 'peer' | 'host', controlTimeoutMs: number = 5000): Promise<WebTransportLink> {
        let control: BidiStream;
        if (role === 'peer') {
            control = await wt.createBidirectionalStream();
        } else {
            const reader = wt.incomingBidirectionalStreams.getReader();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const first = await Promise.race([
                    reader.read(),
                    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no control stream from the peer')), controlTimeoutMs); }),
                ]);
                if (first.done || !first.value) throw new Error('session closed before its control stream opened');
                control = first.value;
            } finally {
                clearTimeout(timer);
                reader.releaseLock();
            }
        }
        return new WebTransportLink(wt, control);
    }

    public sendControl(message: Bytes): void {
        if (this.isClosed) return;
        this._controlWriter.write(frame(message)).catch((e) => this._lost(e));
    }

    public sendPulse(message: Bytes): boolean {
        if (this.isClosed || !this._datagramWriter || message.length > this.pulseBudget) return false;
        // Not awaited: a datagram that cannot be sent is simply lost, which the pulse lane allows.
        this._datagramWriter.write(message).catch(() => {});
        return true;
    }

    public sendBulk(message: Bytes): void {
        if (this.isClosed) return;
        (async () => {
            const stream = await this._wt.createUnidirectionalStream();
            const w = stream.getWriter();
            for (let o = 0; o < message.length; o += 64 * 1024) await w.write(message.subarray(o, o + 64 * 1024));
            await w.close();
        })().catch((e) => this._lost(e));
    }

    protected _closeTransport(reason: string): void {
        try { this._wt.close({ closeCode: 0, reason }); } catch { /* already closed */ }
    }

    private _lost(e: unknown): void {
        if (this.isClosed) return;
        this.close(`lost: ${(e as any)?.message ?? e}`);
    }

    private _readControl(readable: ReadableStream<Bytes>): void {
        const feed = frameReader((m) => this.onControl?.(m));
        (async () => {
            const r = readable.getReader();
            for (;;) {
                const { value, done } = await r.read();
                if (done) break;
                feed(value);
            }
            if (!this.isClosed) this.close('control stream ended');
        })().catch((e) => this._lost(e));
    }

    private _readDatagrams(): void {
        (async () => {
            const r = this._wt.datagrams.readable.getReader();
            for (;;) {
                const { value, done } = await r.read();
                if (done) break;
                this.onPulse?.(value);
            }
        })().catch(() => { /* the session's `closed` reports why */ });
    }

    private _readBulk(): void {
        (async () => {
            const r = this._wt.incomingUnidirectionalStreams.getReader();
            for (;;) {
                const { value: stream, done } = await r.read();
                if (done) break;
                (async () => {
                    const sr = stream.getReader();
                    const chunks: Bytes[] = [];
                    for (;;) {
                        const { value, done: end } = await sr.read();
                        if (end) break;
                        chunks.push(value);
                    }
                    this.onBulk?.(concatBytes(chunks));
                })().catch(() => { /* a broken bulk stream loses that one message */ });
            }
        })().catch(() => { /* the session's `closed` reports why */ });
    }
}
