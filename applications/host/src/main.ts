// cleo-host (docs/design/netsync.md §7): a NetSync dedicated host. Phase 1 runs a session with no game in it —
// peers join, sync their clocks, drop and reconnect — so links and sessions can be tried end to end. Phase 2
// puts a headless scene behind it.
//
//   npm start -- [--wt-port 4433] [--ws-port 4480] [--tick-rate 30] [--max-peers 16] [--content dev]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixedTicker, HostSession } from '../../../src/netsync';
import { cachedCertificate } from './devCertificate';
import { HostListener } from './hostListener';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${line}`);

const session = new HostSession({
    contentHash: arg('--content', 'dev'),
    tickRate: Number(arg('--tick-rate', '30')),
    maxPeers: Number(arg('--max-peers', '16')),
});
session.on('join', (p) => log(`peer ${p.id} joined (${p.name || 'unnamed'}) over ${p.linkKind}`));
session.on('drop', (e) => log(`peer ${e.peer.id} dropped: ${e.reason} — seat held ${session.reconnectGraceMs} ms`));
session.on('resume', (p) => log(`peer ${p.id} is back over ${p.linkKind}`));
session.on('leave', (e) => log(`peer ${e.peer.id} left: ${e.reason}`));

const certificate = await cachedCertificate(path.join(here, '..', '.cache'));
const listener = await HostListener.start({
    certificate,
    webTransportPort: Number(arg('--wt-port', '4433')),
    webSocketPort: Number(arg('--ws-port', '4480')),
    onLink: (link) => session.accept(link),
    log,
});

// The tick loop the simulation will run on (phase 2); for now it only reports.
const ticker = new FixedTicker(session.tickRate, (tick) => {
    if (tick > 0 && tick % (session.tickRate * 10) === 0) {
        const peers = [...session.peers.values()].map((p) => `${p.id}:${p.connected ? p.linkKind : 'held'}`).join(' ') || 'none';
        log(`tick ${tick} (skipped ${ticker.skipped}) peers ${peers}`);
    }
});
ticker.start(performance.now() - session.timeMs());

console.log(`cleo-host (NetSync phase 1)
  WebTransport  udp/${listener.webTransportPort}  /netsync   cert sha-256 ${certificate.hash} (expires ${certificate.notAfter})
  WebSocket     tcp/${listener.webSocketPort}  /ws
  Endpoint      http://localhost:${listener.webSocketPort}/endpoint  (a HostEndpoint for PeerSession.join)
  Session       ${session.tickRate} Hz, ${session.maxPeers} seats, content "${session.contentHash}"`);

const shutdown = async (signal: string) => {
    log(`${signal}: closing`);
    ticker.stop();
    session.close('host shutting down');
    await new Promise((r) => setTimeout(r, 300));
    await listener.close();
    process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
