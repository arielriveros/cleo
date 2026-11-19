// A NetLink over a WebSocket: the fallback for networks and browsers without WebTransport
// (docs/design/netsync.md §4.6). Like webTransportLink.ts it serves both ends — the browser's `WebSocket` and
// the Node `ws` package's socket have the same shape here.
//
// All three lanes share one TCP connection. Every WebSocket message is `u8 lane | payload`; bulk messages are
// cut into chunks (`u32 transfer | u32 total | bytes`) and paced by the socket's backlog, so a big transfer
// cannot hold control messages up for long.

import { LinkBase, PULSE_BUDGET, type LinkKind } from './netLink';

type Bytes = Uint8Array;

export const LANE_CONTROL = 0;
export const LANE_BULK = 1;
export const LANE_PULSE = 2;

/**
 * Bytes a socket may have waiting to send before a pulse is skipped rather than queued. On TCP nothing is
 * lost, only late, and a pulse queued behind a backlog arrives stale; the next pulse carries newer state.
 */
export const WEBSOCKET_BACKLOG_LIMIT = 64 * 1024;
const BULK_CHUNK = 16 * 1024;

/** The parts of a WebSocket this link uses: the browser's and the `ws` package's both fit. */
export interface WebSocketLike {
    binaryType: string;
    readonly bufferedAmount: number;
    readonly readyState: number;
    send(data: Bytes): void;
    close(code?: number, reason?: string): void;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onclose: ((ev: { code: number; reason: string }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
}

const OPEN = 1;

export class WebSocketLink extends LinkBase {
    public readonly kind: LinkKind = 'websocket';
    public readonly pulseBudget = PULSE_BUDGET;
    /** Pulses skipped because the socket had a backlog (see {@link WEBSOCKET_BACKLOG_LIMIT}). */
    public skippedPulses = 0;
    private _nextTransfer = 1;
    private readonly _incoming = new Map<number, { buf: Bytes; got: number }>();
    private _bulkQueue: Promise<void> = Promise.resolve();

    /** Wrap a socket that is already open. */
    constructor(private readonly _ws: WebSocketLike) {
        super();
        _ws.binaryType = 'arraybuffer';
        _ws.onmessage = (ev) => this._receive(ev.data);
        _ws.onclose = (ev) => this._markClosed(ev.reason || `socket closed (${ev.code})`);
        _ws.onerror = () => { /* onclose follows with the reason */ };
        if (_ws.readyState !== OPEN) queueMicrotask(() => this._markClosed('socket not open'));
    }

    public sendControl(message: Bytes): void {
        this._send(LANE_CONTROL, message);
    }

    public sendPulse(message: Bytes): boolean {
        if (this.isClosed || message.length > this.pulseBudget) return false;
        if (this._ws.bufferedAmount > WEBSOCKET_BACKLOG_LIMIT) { this.skippedPulses++; return false; }
        this._send(LANE_PULSE, message);
        return true;
    }

    public sendBulk(message: Bytes): void {
        if (this.isClosed) return;
        const id = this._nextTransfer++ >>> 0;
        this._bulkQueue = this._bulkQueue.then(async () => {
            for (let o = 0; o === 0 || o < message.length; o += BULK_CHUNK) {
                while (!this.isClosed && this._ws.bufferedAmount > WEBSOCKET_BACKLOG_LIMIT) await sleep(2);
                if (this.isClosed) return;
                const chunk = message.subarray(o, o + BULK_CHUNK);
                const out = new Uint8Array(9 + chunk.length);
                const dv = new DataView(out.buffer);
                out[0] = LANE_BULK;
                dv.setUint32(1, id);
                dv.setUint32(5, message.length);
                out.set(chunk, 9);
                this._ws.send(out);
            }
        }).catch(() => { /* the socket's onclose reports it */ });
    }

    protected _closeTransport(reason: string): void {
        try { this._ws.close(1000, reason.slice(0, 120)); } catch { /* already closed */ }
    }

    private _send(lane: number, message: Bytes): void {
        if (this.isClosed) return;
        const out = new Uint8Array(1 + message.length);
        out[0] = lane;
        out.set(message, 1);
        try { this._ws.send(out); } catch (e) { this.close(`send failed: ${(e as any)?.message ?? e}`); }
    }

    private _receive(data: unknown): void {
        const m = toBytes(data);
        if (!m || m.length === 0) return;
        const payload = m.subarray(1);
        switch (m[0]) {
            case LANE_CONTROL: this.onControl?.(payload); break;
            case LANE_PULSE: this.onPulse?.(payload); break;
            case LANE_BULK: this._receiveBulkChunk(payload); break;
        }
    }

    private _receiveBulkChunk(p: Bytes): void {
        if (p.length < 8) return;
        const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const id = dv.getUint32(0);
        const total = dv.getUint32(4);
        const bytes = p.subarray(8);
        let t = this._incoming.get(id);
        if (!t) { t = { buf: new Uint8Array(total), got: 0 }; this._incoming.set(id, t); }
        t.buf.set(bytes, t.got);
        t.got += bytes.length;
        if (t.got >= total) {
            this._incoming.delete(id);
            this.onBulk?.(t.buf);
        }
    }
}

/**
 * Open a WebSocket and wait for it to connect (or fail, or time out).
 * @param WebSocketImpl the constructor to use; the platform's `WebSocket` by default.
 */
export function openWebSocket(url: string, timeoutMs: number = 5000, WebSocketImpl?: new (url: string) => WebSocketLike): Promise<WebSocketLike> {
    const Impl = WebSocketImpl ?? (globalThis as any).WebSocket;
    if (!Impl) return Promise.reject(new Error('no WebSocket on this platform'));
    return new Promise((resolve, reject) => {
        const ws: WebSocketLike & { onopen?: unknown } = new Impl(url);
        ws.binaryType = 'arraybuffer';
        const timer = setTimeout(() => { fail(new Error(`WebSocket open timed out after ${timeoutMs} ms`)); try { ws.close(); } catch { /* */ } }, timeoutMs);
        let settled = false;
        const fail = (e: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); };
        ws.onopen = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(ws); };
        ws.onerror = () => fail(new Error(`WebSocket to ${url} failed`));
        ws.onclose = (ev) => fail(new Error(`WebSocket to ${url} closed (${ev.code})`));
    });
}

function toBytes(data: unknown): Bytes | null {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Array.isArray(data)) { // `ws` delivers fragmented messages as Buffer[] when binaryType is 'fragments'
        let total = 0;
        for (const part of data) total += (part as Bytes).length;
        const out = new Uint8Array(total);
        let o = 0;
        for (const part of data) { out.set(part as Bytes, o); o += (part as Bytes).length; }
        return out;
    }
    return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
