#!/usr/bin/env node
// NetSync phase-0 spike host (docs/design/netsync.md §4, §10 phase 0).
//
//   node host.mjs [--wt-port 4433] [--http-port 4480] [--https-port 4481]
//
// Serves:
//   UDP  --wt-port     WebTransport (HTTP/3) at /netsync, self-signed ECDSA cert pinned by hash
//   TCP  --http-port   the probe page for this machine (http://localhost is a secure context), /ws, /cert-hash, /report
//   TCP  --https-port  the same over HTTPS with the dev cert, for other devices on the LAN (accept the warning once)
//
// Every link — WebTransport session or WebSocket — goes to the same `servePeer`, which only sees lanes.
import { Http3Server } from '@fails-components/webtransport';
import { WebSocketServer } from 'ws';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { devCertificate } from './cert.mjs';
import { CTRL, DGRAM, LANE, frame, frameReader, jsonMsg, readJson, seqDatagram } from './public/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const now = () => performance.now();

// ----- the transport-agnostic peer handler --------------------------------------------------------------

let nextPeerId = 1;

/**
 * One connected peer. `link` is `{ kind, sendControl, sendDatagram → boolean, sendBulk(bytes) → Promise,
 * onControl, onDatagram, onClose }` — the host-side twin of public/link.js.
 */
function servePeer(link, log) {
    const peerId = nextPeerId++;
    let sizes = {};
    let pulseTimer = null;
    log(`peer ${peerId} connected over ${link.kind}`);

    link.onControl = (m) => {
        switch (m[0]) {
            case CTRL.hello: {
                const hello = readJson(m);
                log(`peer ${peerId} hello: ${hello.ua}`);
                link.sendControl(jsonMsg(CTRL.welcome, { peerId, linkKind: link.kind, hostTime: Date.now() }));
                break;
            }
            case CTRL.echo:
                link.sendControl(m);
                break;
            case CTRL.pulses: {
                const { hz, size, count } = readJson(m);
                clearTimeout(pulseTimer);
                let seq = 0, sent = 0, skipped = 0;
                // Deadline-driven, not setInterval: Windows rounds timers to ~15.6 ms, so setInterval(33.3)
                // fires every ~47 ms (21 Hz). Sending every pulse whose deadline has passed keeps the rate exact.
                const period = 1000 / hz;
                const start = now();
                const tick = () => {
                    while (seq < count && start + seq * period <= now()) {
                        if (link.sendDatagram(seqDatagram(DGRAM.pulse, seq, now(), size))) sent++; else skipped++;
                        seq++;
                    }
                    if (seq >= count) { link.sendControl(jsonMsg(CTRL.pulsesDone, { sent, skipped })); return; }
                    pulseTimer = setTimeout(tick, Math.max(0, start + seq * period - now()));
                };
                tick();
                break;
            }
            case CTRL.sizeBegin:
                sizes = {};
                break;
            case CTRL.sizeEnd:
                link.sendControl(jsonMsg(CTRL.sizeResult, { received: sizes }));
                break;
            case CTRL.bulk: {
                const { bytes } = readJson(m);
                const payload = new Uint8Array(bytes);
                for (let i = 0; i < bytes; i++) payload[i] = i & 0xff;
                const t0 = now();
                link.sendBulk(payload)
                    .then(() => log(`peer ${peerId} bulk ${bytes} B sent in ${Math.round(now() - t0)} ms`))
                    .catch((e) => log(`peer ${peerId} bulk failed: ${e?.message ?? e}`));
                break;
            }
        }
    };

    link.onDatagram = (d) => {
        if (d[0] === DGRAM.ping) {
            const pong = new Uint8Array(d);
            pong[0] = DGRAM.pong;
            link.sendDatagram(pong);
        } else if (d[0] === DGRAM.size) {
            sizes[d.length] = (sizes[d.length] ?? 0) + 1;
        }
    };

    link.onClose = () => {
        clearTimeout(pulseTimer);
        log(`peer ${peerId} closed`);
    };
}

// ----- WebTransport ---------------------------------------------------------------------------------------

async function serveWebTransportSession(session, log) {
    await session.ready;
    const link = { kind: 'webtransport', onControl: null, onDatagram: null, onClose: null };

    const dgWritable = typeof session.datagrams.createWritable === 'function'
        ? session.datagrams.createWritable()
        : session.datagrams.writable;
    const dgWriter = dgWritable.getWriter();
    link.sendDatagram = (bytes) => { dgWriter.write(bytes).catch(() => {}); return true; };

    link.sendBulk = async (bytes) => {
        const stream = await session.createUnidirectionalStream();
        const w = stream.getWriter();
        for (let o = 0; o < bytes.length; o += 16384) await w.write(bytes.subarray(o, o + 16384));
        await w.close();
    };

    // The control stream is the first bidirectional stream the peer opens.
    let ctrlWriter = null;
    const pending = [];
    link.sendControl = (bytes) => {
        if (ctrlWriter) ctrlWriter.write(frame(bytes)).catch(() => {});
        else pending.push(bytes);
    };

    servePeer(link, log);

    (async () => {
        const r = session.incomingBidirectionalStreams.getReader();
        const { value: stream, done } = await r.read();
        if (done) return;
        ctrlWriter = stream.writable.getWriter();
        for (const p of pending.splice(0)) link.sendControl(p);
        const feed = frameReader((m) => link.onControl?.(m));
        const sr = stream.readable.getReader();
        for (;;) { const { value, done: end } = await sr.read(); if (end) break; feed(value); }
    })().catch(() => {});

    (async () => {
        const r = session.datagrams.readable.getReader();
        for (;;) { const { value, done } = await r.read(); if (done) break; link.onDatagram?.(value); }
    })().catch(() => {});

    session.closed.then(() => link.onClose?.(), () => link.onClose?.());
}

// ----- WebSocket fallback ---------------------------------------------------------------------------------

/** Bytes a WebSocket may have queued before the host skips a pulse instead of adding to the queue (§4.6). */
const WS_PULSE_QUEUE_LIMIT = 64 * 1024;

function serveWebSocket(ws, log) {
    const link = { kind: 'websocket', onControl: null, onDatagram: null, onClose: null };
    const send = (lane, bytes) => {
        const out = Buffer.allocUnsafe(1 + bytes.length);
        out[0] = lane;
        out.set(bytes, 1);
        ws.send(out);
    };
    link.sendControl = (bytes) => send(LANE.control, bytes);
    link.sendDatagram = (bytes) => {
        if (ws.bufferedAmount > WS_PULSE_QUEUE_LIMIT) return false; // never queue pulses behind each other
        send(LANE.pulse, bytes);
        return true;
    };
    // Chunked and paced by the socket's queue, so control messages interleave with a big transfer.
    link.sendBulk = async (bytes) => {
        for (let o = 0; o < bytes.length; o += 16384) {
            while (ws.bufferedAmount > WS_PULSE_QUEUE_LIMIT) await new Promise((r) => setTimeout(r, 2));
            send(LANE.bulk, bytes.subarray(o, o + 16384));
        }
    };
    servePeer(link, log);
    ws.on('message', (data) => {
        const m = new Uint8Array(data);
        const payload = m.subarray(1);
        if (m[0] === LANE.control) link.onControl?.(payload);
        else if (m[0] === LANE.pulse) link.onDatagram?.(payload);
    });
    ws.on('close', () => link.onClose?.());
}

// ----- HTTP(S): page, cert hash, reports, WebSocket upgrade ---------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };

function httpHandler(cert, wtPort, resultsDir, log) {
    return (req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/cert-hash') {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
            res.end(JSON.stringify({ hash: cert.hash, wtPort, notAfter: cert.notAfter }));
            return;
        }
        if (url.pathname === '/report' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                try {
                    const r = JSON.parse(body);
                    mkdirSync(resultsDir, { recursive: true });
                    const name = `${r.when?.replace(/[:.]/g, '-') ?? Date.now()}-${r.label ?? 'probe'}.json`;
                    writeFileSync(path.join(resultsDir, name), JSON.stringify(r, null, 2));
                    log(`report saved: results/${name} (${r.link?.kind ?? 'no link'}; errors: ${r.errors?.length ?? '-'})`);
                } catch (e) { log(`bad report: ${e.message}`); }
                res.writeHead(204); res.end();
            });
            return;
        }
        const file = path.join(here, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
        if (!file.startsWith(path.join(here, 'public')) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(readFileSync(file));
    };
}

// ----- start ------------------------------------------------------------------------------------------------

export async function startHost({ wtPort = 4433, httpPort = 4480, httpsPort = 4481, quiet = false } = {}) {
    const log = quiet ? () => {} : (line) => console.log(`[host] ${line}`);
    const cert = await devCertificate(path.join(here, '.cache'));
    const resultsDir = path.join(here, 'results');

    const h3 = new Http3Server({
        // '::' is dual-stack (IPv6 + IPv4-mapped). With '0.0.0.0' Chrome fails the handshake for a page on
        // http://localhost, because it resolves localhost to ::1 first and QUIC does not retry on IPv4.
        port: wtPort, host: process.env.NETSYNC_WT_HOST ?? '::',
        secret: randomBytes(16).toString('hex'),
        cert: cert.cert, privKey: cert.key,
    });
    h3.startServer();
    await h3.ready;
    const actualWtPort = h3.address()?.port ?? wtPort;
    (async () => {
        const sessions = (await h3.sessionStream('/netsync')).getReader();
        for (;;) {
            const { value: session, done } = await sessions.read();
            if (done) break;
            serveWebTransportSession(session, log).catch((e) => log(`session error: ${e?.message ?? e}`));
        }
    })().catch((e) => log(`session stream error: ${e?.message ?? e}`));

    const handler = httpHandler(cert, actualWtPort, resultsDir, log);
    const http = createHttp(handler);
    const https = createHttps({ cert: cert.cert, key: cert.key }, handler);
    for (const server of [http, https]) {
        const wss = new WebSocketServer({ server, path: '/ws' });
        wss.on('connection', (ws) => serveWebSocket(ws, log));
    }
    await new Promise((r) => http.listen(httpPort, '0.0.0.0', r));
    await new Promise((r) => https.listen(httpsPort, '0.0.0.0', r));

    const info = {
        wtPort: actualWtPort, httpPort: http.address().port, httpsPort: https.address().port,
        certHash: cert.hash, certExpires: cert.notAfter, addresses: cert.addresses,
    };
    const stop = async () => {
        h3.stopServer();
        await Promise.all([http, https].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
    };
    return { info, stop };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
    const { info } = await startHost({ wtPort: arg('--wt-port', 4433), httpPort: arg('--http-port', 4480), httpsPort: arg('--https-port', 4481) });
    console.log(`NetSync spike host
  WebTransport  udp/${info.wtPort}  /netsync   cert sha-256 ${info.certHash} (expires ${info.certExpires})
  This machine  http://localhost:${info.httpPort}/
  LAN devices   ${info.addresses.filter((a) => a !== '127.0.0.1').map((a) => `https://${a}:${info.httpsPort}/`).join('  ') || '(no LAN address)'}
                (self-signed: accept the certificate warning once; WebTransport itself is pinned by hash)
  Reports       ${path.join(here, 'results')}`);
}
