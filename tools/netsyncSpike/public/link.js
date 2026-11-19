// NetSync phase-0 spike: the peer's side of a link. `connect()` tries WebTransport first and falls back to a
// WebSocket (docs/design/netsync.md §4.6). Both links expose the same small interface, so the probe that runs
// over them never asks which one it has:
//
//   { kind, sendControl(bytes), sendDatagram(bytes) → boolean, onControl, onDatagram, onBulk,
//     maxDatagramSize, writerKind, fallbackReason, connectMs, close() }
//
// Runs in browsers and in Node (pass `WebTransportImpl` from @fails-components/webtransport there).
import { LANE, base64ToBytes, frame, frameReader, withLane } from './protocol.js';

const now = () => performance.now();

function timeout(ms, what) {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms));
}

/**
 * @param {object} o
 * @param {string} o.base            the host's HTTP(S) origin, e.g. "https://192.168.1.20:8443"
 * @param {'wt'|'ws'|null} [o.force] only try this link
 * @param {number} [o.wtPort]        override the WebTransport port (a wrong one simulates blocked UDP)
 * @param {number} [o.wtTimeoutMs]   how long WebTransport gets before falling back (default 2500)
 */
export async function connect(o) {
    const info = await (await fetch(`${o.base}/cert-hash`)).json();
    const WT = o.WebTransportImpl ?? globalThis.WebTransport;
    let fallbackReason = null;
    if (o.force !== 'ws') {
        if (!WT) {
            fallbackReason = 'no WebTransport in this browser';
        } else {
            const host = new URL(o.base).hostname;
            const url = `https://${host.includes(':') ? `[${host}]` : host}:${o.wtPort ?? info.wtPort}/netsync`;
            try {
                return await connectWebTransport(WT, url, info.hash, o.wtTimeoutMs ?? 2500);
            } catch (e) {
                fallbackReason = `WebTransport failed: ${e?.message ?? e}`;
                if (o.force === 'wt') throw new Error(fallbackReason);
            }
        }
    } else {
        fallbackReason = 'forced';
    }
    const link = await connectWebSocket(o.WebSocketImpl ?? globalThis.WebSocket, `${o.base.replace(/^http/, 'ws')}/ws`);
    link.fallbackReason = fallbackReason;
    return link;
}

async function connectWebTransport(WT, url, hashB64, timeoutMs) {
    const t0 = now();
    const wt = new WT(url, { serverCertificateHashes: [{ algorithm: 'sha-256', value: base64ToBytes(hashB64) }] });
    wt.closed?.catch?.(() => {});
    try {
        await Promise.race([wt.ready, timeout(timeoutMs, 'WebTransport ready')]);
    } catch (e) {
        try { wt.close(); } catch { /* already failed */ }
        throw e;
    }
    const link = {
        kind: 'webtransport', fallbackReason: null, connectMs: 0,
        onControl: null, onDatagram: null, onBulk: null,
        maxDatagramSize: wt.datagrams?.maxDatagramSize ?? null,
        writerKind: null,
        close: () => { try { wt.close(); } catch { /* closed */ } },
    };

    // Datagram writer: the current spec has `createWritable()`; older implementations a `writable` property.
    let dgWritable = null;
    if (typeof wt.datagrams.createWritable === 'function') {
        try { dgWritable = wt.datagrams.createWritable(); link.writerKind = 'createWritable()'; } catch { /* try the other */ }
    }
    if (!dgWritable && wt.datagrams.writable) { dgWritable = wt.datagrams.writable; link.writerKind = 'writable'; }
    const dgWriter = dgWritable?.getWriter() ?? null;
    if (!dgWriter) link.writerKind = 'none';
    link.sendDatagram = (bytes) => {
        if (!dgWriter) return false;
        dgWriter.write(bytes).catch(() => {});
        return true;
    };

    // Control lane: one bidirectional stream, opened by the peer.
    const ctrl = await wt.createBidirectionalStream();
    const ctrlWriter = ctrl.writable.getWriter();
    link.sendControl = (bytes) => { ctrlWriter.write(frame(bytes)).catch(() => {}); };
    const feed = frameReader((m) => link.onControl?.(m));
    (async () => {
        const r = ctrl.readable.getReader();
        for (;;) { const { value, done } = await r.read(); if (done) break; feed(value); }
    })().catch(() => {});

    // Pulse lane.
    (async () => {
        const r = wt.datagrams.readable.getReader();
        for (;;) { const { value, done } = await r.read(); if (done) break; link.onDatagram?.(value); }
    })().catch(() => {});

    // Bulk lane: each incoming unidirectional stream is one transfer.
    (async () => {
        const r = wt.incomingUnidirectionalStreams.getReader();
        for (;;) {
            const { value: stream, done } = await r.read();
            if (done) break;
            (async () => {
                const sr = stream.getReader();
                for (;;) { const { value, done: end } = await sr.read(); if (end) break; link.onBulk?.(value); }
            })().catch(() => {});
        }
    })().catch(() => {});

    link.connectMs = now() - t0;
    return link;
}

async function connectWebSocket(WS, url) {
    const t0 = now();
    const ws = new WS(url);
    ws.binaryType = 'arraybuffer';
    await Promise.race([
        new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = () => reject(new Error('WebSocket error'));
        }),
        timeout(5000, 'WebSocket open'),
    ]);
    const link = {
        kind: 'websocket', fallbackReason: null, connectMs: now() - t0,
        onControl: null, onDatagram: null, onBulk: null,
        maxDatagramSize: null, writerKind: 'websocket',
        sendControl: (bytes) => ws.send(withLane(LANE.control, bytes)),
        // On TCP a "datagram" is never lost, only late. A peer has little to send, so it always sends.
        sendDatagram: (bytes) => { ws.send(withLane(LANE.pulse, bytes)); return true; },
        close: () => ws.close(),
    };
    ws.onmessage = (e) => {
        const m = new Uint8Array(e.data);
        const payload = m.subarray(1);
        if (m[0] === LANE.control) link.onControl?.(payload);
        else if (m[0] === LANE.pulse) link.onDatagram?.(payload);
        else if (m[0] === LANE.bulk) link.onBulk?.(payload);
    };
    return link;
}
