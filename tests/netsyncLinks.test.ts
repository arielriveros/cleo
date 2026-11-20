import { describe, expect, it } from 'vitest';
import { ManualScheduler } from '../src/netsync/time';
import { createLoopbackPair } from '../src/netsync/link/loopbackLink';
import { ConditionedLink } from '../src/netsync/link/conditionedLink';
import { WEBSOCKET_BACKLOG_LIMIT, WebSocketLink, type WebSocketLike } from '../src/netsync/link/webSocketLink';
import { WebTransportLink, type WebTransportLike } from '../src/netsync/link/webTransportLink';
import { connect } from '../src/netsync/link/connect';
import { PULSE_BUDGET, type NetLink } from '../src/netsync/link/netLink';

const bytes = (...v: number[]) => new Uint8Array(v);

function record(link: NetLink) {
    const got = { control: [] as number[][], pulse: [] as number[][], bulk: [] as number[][], closed: [] as string[] };
    link.onControl = (m) => got.control.push(Array.from(m));
    link.onPulse = (m) => got.pulse.push(Array.from(m));
    link.onBulk = (m) => got.bulk.push(Array.from(m));
    link.onClose = (r) => got.closed.push(r);
    return got;
}

describe('loopback links', () => {
    it('delivers each lane to the other end, asynchronously', async () => {
        const s = new ManualScheduler();
        const [a, b] = createLoopbackPair(s);
        const got = record(b);
        a.sendControl(bytes(1));
        a.sendPulse(bytes(2));
        a.sendBulk(bytes(3, 3));
        expect(got.control).toEqual([]); // never inside the send call
        await s.advance(0);
        expect(got).toMatchObject({ control: [[1]], pulse: [[2]], bulk: [[3, 3]] });
    });

    it('rejects a pulse over the budget', () => {
        const [a] = createLoopbackPair(new ManualScheduler());
        expect(a.sendPulse(new Uint8Array(PULSE_BUDGET))).toBe(true);
        expect(a.sendPulse(new Uint8Array(PULSE_BUDGET + 1))).toBe(false);
    });

    it('closes both ends, once', async () => {
        const s = new ManualScheduler();
        const [a, b] = createLoopbackPair(s);
        const ga = record(a), gb = record(b);
        a.close('bye');
        a.close('again');
        await s.advance(0);
        expect(ga.closed).toEqual(['bye']);
        expect(gb.closed).toEqual(['bye']);
        expect(b.isClosed).toBe(true);
    });
});

describe('ConditionedLink', () => {
    it('delays by the latency and keeps control in order under jitter', async () => {
        const s = new ManualScheduler();
        const [a, b] = createLoopbackPair(s);
        const slow = new ConditionedLink(a, { latencyMs: 50, jitterMs: 40, seed: 7 }, s);
        const got = record(b);
        for (let i = 0; i < 20; i++) slow.sendControl(bytes(i));
        await s.advance(49);
        expect(got.control.length).toBe(0);
        await s.advance(100);
        expect(got.control.map((m) => m[0])).toEqual([...Array(20).keys()]);
    });

    it('conditions the incoming direction too', async () => {
        const s = new ManualScheduler();
        const [a, b] = createLoopbackPair(s);
        const slow = new ConditionedLink(a, { latencyMs: 30 }, s);
        const got = record(slow);
        b.sendControl(bytes(1));
        await s.advance(29);
        expect(got.control).toEqual([]);
        await s.advance(2);
        expect(got.control).toEqual([[1]]);
    });

    it('loses about the configured share of pulses', async () => {
        const s = new ManualScheduler();
        const [a, b] = createLoopbackPair(s);
        const lossy = new ConditionedLink(a, { latencyMs: 10, loss: 0.2, seed: 3 }, s);
        const got = record(b);
        for (let i = 0; i < 1000; i++) lossy.sendPulse(bytes(i & 0xff));
        await s.advance(50);
        expect(got.pulse.length + lossy.dropped).toBe(1000);
        expect(lossy.dropped).toBeGreaterThan(150);
        expect(lossy.dropped).toBeLessThan(250);
    });

    it('in tcp mode loses nothing, keeps order, and stalls behind a retransmit', async () => {
        const s = new ManualScheduler();
        const [a, b] = createLoopbackPair(s);
        const tcp = new ConditionedLink(a, { latencyMs: 20, loss: 0.3, tcp: true, seed: 5 }, s);
        const got = record(b);
        const arrivals: number[] = [];
        b.onPulse = (m) => { got.pulse.push(Array.from(m)); arrivals.push(s.now()); };
        for (let i = 0; i < 50; i++) tcp.sendPulse(bytes(i));
        await s.advance(1000);
        expect(got.pulse.map((m) => m[0])).toEqual([...Array(50).keys()]);
        // A retransmit costs a round trip, and everything after it waits.
        expect(Math.max(...arrivals)).toBeGreaterThanOrEqual(60);
    });
});

/** A WebSocket stand-in: what is sent lands in `sent`; `deliver` plays a message in. */
class FakeSocket implements WebSocketLike {
    binaryType = 'blob';
    bufferedAmount = 0;
    readyState = 1;
    sent: Uint8Array[] = [];
    closed: { code?: number; reason?: string } | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    send(data: Uint8Array) { this.sent.push(data.slice()); }
    close(code?: number, reason?: string) { this.closed = { code, reason }; this.onclose?.({ code: code ?? 1000, reason: reason ?? '' }); }
    deliver(data: Uint8Array) { this.onmessage?.({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }); }
}

/** Two fake sockets wired to each other. */
function socketPair(): [FakeSocket, FakeSocket] {
    const a = new FakeSocket(), b = new FakeSocket();
    a.send = (d) => { a.sent.push(d.slice()); b.deliver(d); };
    b.send = (d) => { b.sent.push(d.slice()); a.deliver(d); };
    return [a, b];
}

describe('WebSocketLink', () => {
    it('tags each lane and reads them back', () => {
        const [sa, sb] = socketPair();
        const a = new WebSocketLink(sa), b = new WebSocketLink(sb);
        const got = record(b);
        a.sendControl(bytes(1));
        a.sendPulse(bytes(2));
        expect(sa.binaryType).toBe('arraybuffer');
        expect(got).toMatchObject({ control: [[1]], pulse: [[2]] });
    });

    it('sends bulk in chunks and reassembles it whole', async () => {
        const [sa, sb] = socketPair();
        const a = new WebSocketLink(sa), b = new WebSocketLink(sb);
        const done = new Promise<Uint8Array>((r) => { b.onBulk = r; });
        const big = new Uint8Array(100_000).map((_, i) => i & 0xff);
        a.sendBulk(big);
        const got = await done;
        expect(sa.sent.length).toBeGreaterThan(5);
        expect(got).toEqual(big);
    });

    it('delivers an empty bulk message', async () => {
        const [sa, sb] = socketPair();
        const a = new WebSocketLink(sa), b = new WebSocketLink(sb);
        const done = new Promise<Uint8Array>((r) => { b.onBulk = r; });
        a.sendBulk(new Uint8Array(0));
        expect((await done).length).toBe(0);
    });

    it('skips a pulse rather than queue it behind a backlog; control always goes', () => {
        const s = new FakeSocket();
        const link = new WebSocketLink(s);
        s.bufferedAmount = WEBSOCKET_BACKLOG_LIMIT + 1;
        expect(link.sendPulse(bytes(1))).toBe(false);
        expect(link.skippedPulses).toBe(1);
        link.sendControl(bytes(2));
        expect(s.sent.length).toBe(1);
    });

    it('reports the socket closing', () => {
        const s = new FakeSocket();
        const link = new WebSocketLink(s);
        const got = record(link);
        s.onclose!({ code: 1006, reason: '' });
        expect(link.isClosed).toBe(true);
        expect(got.closed[0]).toContain('1006');
    });
});

/** A WebTransport stand-in made of real web streams: two of them, connected. */
function transportPair(opts: { createWritableOnly?: boolean; maxDatagramSize?: number } = {}): [WebTransportLike, WebTransportLike] {
    const pipe = () => { const t = new TransformStream<Uint8Array, Uint8Array>(); return { r: t.readable, w: t.writable }; };
    const dgAB = pipe(), dgBA = pipe();
    const bidiAB = new TransformStream<any, any>(), uniAB = new TransformStream<any, any>(), uniBA = new TransformStream<any, any>();
    const bidiBA = new TransformStream<any, any>();
    let closeA!: (v: unknown) => void, closeB!: (v: unknown) => void;
    const make = (dgIn: ReadableStream<Uint8Array>, dgOut: WritableStream<Uint8Array>, bidiOut: WritableStream<any>, bidiIn: ReadableStream<any>,
        uniOut: WritableStream<any>, uniIn: ReadableStream<any>, closed: Promise<unknown>, closeOther: () => void): WebTransportLike => {
        const bidiWriter = bidiOut.getWriter();
        const uniWriter = uniOut.getWriter();
        const datagrams: any = { readable: dgIn, maxDatagramSize: opts.maxDatagramSize };
        if (opts.createWritableOnly) datagrams.createWritable = () => dgOut; else datagrams.writable = dgOut;
        return {
            ready: Promise.resolve(),
            closed,
            datagrams,
            async createBidirectionalStream() {
                const there = pipe(), back = pipe();
                bidiWriter.write({ readable: there.r, writable: back.w }).catch(() => {});
                return { readable: back.r, writable: there.w };
            },
            incomingBidirectionalStreams: bidiIn,
            async createUnidirectionalStream() {
                const p = pipe();
                uniWriter.write(p.r).catch(() => {});
                return p.w;
            },
            incomingUnidirectionalStreams: uniIn,
            close: () => closeOther(),
        };
    };
    const closedA = new Promise((r) => { closeA = r; });
    const closedB = new Promise((r) => { closeB = r; });
    const both = (reason: string) => { closeA({ reason }); closeB({ reason }); };
    return [
        make(dgBA.r, dgAB.w, bidiAB.writable, bidiBA.readable, uniAB.writable, uniBA.readable, closedA, () => both('closed by a')),
        make(dgAB.r, dgBA.w, bidiBA.writable, bidiAB.readable, uniBA.writable, uniAB.readable, closedB, () => both('closed by b')),
    ];
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('WebTransportLink', () => {
    it('opens the control stream from the peer and carries all three lanes', async () => {
        const [pw, hw] = transportPair();
        const hostOpening = WebTransportLink.open(hw, 'host');
        const peer = await WebTransportLink.open(pw, 'peer');
        peer.sendControl(bytes(1, 2)); // the host only sees the stream once something is written on it
        const host = await hostOpening;
        const got = record(host);
        peer.sendControl(bytes(3));
        peer.sendPulse(bytes(4));
        peer.sendBulk(new Uint8Array(200_000).fill(7));
        await tick();
        await tick();
        expect(got.control).toEqual([[1, 2], [3]]);
        expect(got.pulse).toEqual([[4]]);
        expect(got.bulk[0].length).toBe(200_000);
        const back = record(peer);
        host.sendControl(bytes(9));
        await tick();
        expect(back.control).toEqual([[9]]);
    });

    it('writes datagrams through createWritable() when that is all there is (WebKit)', async () => {
        const [pw] = transportPair({ createWritableOnly: true });
        const link = await WebTransportLink.open(pw, 'peer');
        expect(link.datagramWriter).toBe('createWritable');
        expect(link.sendPulse(bytes(1))).toBe(true);
    });

    it('takes the smaller of its budget and maxDatagramSize', async () => {
        const [pw] = transportPair({ maxDatagramSize: 600 });
        const link = await WebTransportLink.open(pw, 'peer');
        expect(link.pulseBudget).toBe(600);
        expect(link.sendPulse(new Uint8Array(601))).toBe(false);
    });

    it('reports the session closing', async () => {
        const [pw, hw] = transportPair();
        const peer = await WebTransportLink.open(pw, 'peer');
        const got = record(peer);
        hw.close();
        await tick();
        expect(peer.isClosed).toBe(true);
        expect(got.closed).toEqual(['closed by b']);
    });
});

describe('connect', () => {
    const endpoint = { webTransport: { url: 'https://h:1/netsync', certHashes: ['AAAA'] }, webSocket: { url: 'ws://h:2/ws' } };

    class OpenSocket extends FakeSocket {
        static urls: string[] = [];
        onopen: (() => void) | null = null;
        constructor(url: string) { super(); OpenSocket.urls.push(url); setTimeout(() => this.onopen?.(), 0); }
    }

    it('falls back to the WebSocket when WebTransport never becomes ready', async () => {
        class NeverReady {
            ready = new Promise(() => {});
            closed = new Promise(() => {});
            options: any;
            constructor(public url: string, options: any) { this.options = options; NeverReady.last = this; }
            static last: NeverReady;
            close() {}
        }
        const c = await connect(endpoint, { WebTransportImpl: NeverReady as any, WebSocketImpl: OpenSocket as any, webTransportTimeoutMs: 20 });
        expect(c.link.kind).toBe('websocket');
        expect(c.fallbackReason).toContain('not ready after 20 ms');
        expect(NeverReady.last.options.serverCertificateHashes[0].algorithm).toBe('sha-256');
        expect(OpenSocket.urls).toContain('ws://h:2/ws');
    });

    it('falls back when the platform has no WebTransport', async () => {
        const c = await connect({ webSocket: endpoint.webSocket }, { WebSocketImpl: OpenSocket as any });
        expect(c.link.kind).toBe('websocket');
        expect(c.fallbackReason).toBe('host offers no WebTransport');
    });

    it('uses WebTransport when it works', async () => {
        const [pw, hw] = transportPair();
        class Works { ready = Promise.resolve(); constructor() { return pw as any; } }
        const hostSide = WebTransportLink.open(hw, 'host');
        const c = await connect(endpoint, { WebTransportImpl: Works as any, WebSocketImpl: OpenSocket as any });
        expect(c.link.kind).toBe('webtransport');
        expect(c.fallbackReason).toBeNull();
        c.link.sendControl(bytes(1));
        await hostSide;
    });

    it('does not fall back when told to use only WebTransport', async () => {
        class Fails { ready = Promise.reject(new Error('handshake failed')); closed = new Promise(() => {}); close() {} constructor() { this.ready.catch(() => {}); } }
        await expect(connect(endpoint, { only: 'webtransport', WebTransportImpl: Fails as any })).rejects.toThrow('handshake failed');
    });
});
