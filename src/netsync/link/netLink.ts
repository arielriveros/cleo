// A NetLink is one connection between a peer and the host, seen as three lanes (docs/design/netsync.md §4.2).
// Everything above the link — session, sync — only ever sees this interface, so WebTransport, the WebSocket
// fallback, an in-process loopback and a link with simulated latency are interchangeable.

export type LinkKind = 'webtransport' | 'websocket' | 'loopback';

/**
 * Bytes a pulse-lane message may carry. Measured `maxDatagramSize` is 1024 in Firefox 152 and Chromium 126
 * and 1211 in Chromium 157, and an oversize datagram is dropped without an error (phase-0 spike), so 1000
 * fits every browser with room to spare.
 */
export const PULSE_BUDGET = 1000;

export interface NetLink {
    readonly kind: LinkKind;
    /** The largest message `sendPulse` accepts on this link. */
    readonly pulseBudget: number;
    readonly isClosed: boolean;

    /** Control lane: reliable and ordered. */
    sendControl(message: Uint8Array): void;
    /**
     * Pulse lane: unreliable and unordered; a message may be lost. Returns false when the message was not
     * sent — over the budget, the link closed, or (WebSocket) the socket already has a backlog and queueing
     * another pulse behind it would only make it stale.
     */
    sendPulse(message: Uint8Array): boolean;
    /**
     * Bulk lane: reliable, delivered whole, for large one-off transfers (a joining peer's full state). Not
     * ordered relative to control messages or to other bulk messages.
     */
    sendBulk(message: Uint8Array): void;

    onControl: ((message: Uint8Array) => void) | null;
    onPulse: ((message: Uint8Array) => void) | null;
    onBulk: ((message: Uint8Array) => void) | null;
    /** Called once, when the link closes for any reason (including `close()`). */
    onClose: ((reason: string) => void) | null;

    close(reason?: string): void;
}

/** The handlers and close bookkeeping every link shares. */
export abstract class LinkBase implements NetLink {
    public abstract readonly kind: LinkKind;
    public abstract readonly pulseBudget: number;
    public onControl: ((message: Uint8Array) => void) | null = null;
    public onPulse: ((message: Uint8Array) => void) | null = null;
    public onBulk: ((message: Uint8Array) => void) | null = null;
    public onClose: ((reason: string) => void) | null = null;
    private _closed = false;

    public get isClosed(): boolean { return this._closed; }

    public abstract sendControl(message: Uint8Array): void;
    public abstract sendPulse(message: Uint8Array): boolean;
    public abstract sendBulk(message: Uint8Array): void;

    public close(reason: string = 'closed'): void {
        if (this._closed) return;
        this._closeTransport(reason);
        this._markClosed(reason);
    }

    /** Shut the underlying transport. Called once, from `close()`. */
    protected abstract _closeTransport(reason: string): void;

    /** Record that the link is gone (the transport closed on its own, or `close()` ran). Idempotent. */
    protected _markClosed(reason: string): void {
        if (this._closed) return;
        this._closed = true;
        const cb = this.onClose;
        this.onClose = null;
        cb?.(reason);
    }
}

/** `u32 length | payload` — how messages are framed on a WebTransport stream. */
export function frame(payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(4 + payload.length);
    new DataView(out.buffer).setUint32(0, payload.length);
    out.set(payload, 4);
    return out;
}

/** Feed stream chunks in; `onMessage` is called once per whole framed message, in order. */
export function frameReader(onMessage: (message: Uint8Array) => void, maxMessage: number = 16 * 1024 * 1024): (chunk: Uint8Array) => void {
    let buf: Uint8Array = new Uint8Array(0);
    return (chunk) => {
        if (buf.length === 0) {
            buf = chunk;
        } else {
            const next = new Uint8Array(buf.length + chunk.length);
            next.set(buf, 0);
            next.set(chunk, buf.length);
            buf = next;
        }
        while (buf.length >= 4) {
            const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
            if (len > maxMessage) throw new RangeError(`framed message of ${len} bytes is over the ${maxMessage} limit`);
            if (buf.length < 4 + len) break;
            onMessage(buf.slice(4, 4 + len));
            buf = buf.subarray(4 + len);
        }
        if (buf.length === 0) buf = new Uint8Array(0);
        else buf = buf.slice();
    };
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
}
