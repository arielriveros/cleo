// cleo-host (docs/design/netsync.md §7): a NetSync dedicated host. Runs a game headless at a fixed tick rate and
// accepts peers over WebTransport and WebSocket. Phase 2: the game runs and peers join a session alongside it;
// phase 3 sends them its state.
//
//   npm start -- --game path/to/game.bin [--scripts path/to/game.scripts.js]
//   npm start -- --example ../editor/public/examples/firing-line
//   npm start                                     (no game: a session only, as in phase 1)
//
//   [--wt-port 4433] [--ws-port 4480] [--tick-rate 30] [--max-peers 16] [--physics jolt|rapier|cannon]

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostSession, hashContent } from '../../../src/netsync';
import { cachedCertificate } from './devCertificate';
import { HostListener } from './hostListener';
import { HostRuntime } from './hostRuntime';
import { packExampleGame } from './exampleGame';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name: string, fallback?: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${line}`);
const tickRate = Number(arg('--tick-rate', '30'));

// ----- the game ------------------------------------------------------------------------------------------------

let runtime: HostRuntime | null = null;
let contentHash = arg('--content', 'dev')!;
const gamePath = arg('--game');
const examplePath = arg('--example');
if (gamePath || examplePath) {
    let bin: Uint8Array;
    let scripts: string | undefined;
    if (gamePath) {
        bin = new Uint8Array(readFileSync(gamePath));
        const scriptsPath = arg('--scripts') ?? path.join(path.dirname(gamePath), 'game.scripts.js');
        if (existsSync(scriptsPath)) scripts = readFileSync(scriptsPath, 'utf8');
    } else {
        log(`packing ${examplePath}`);
        bin = await packExampleGame(examplePath!);
    }
    // Peers must run exactly this game: the session refuses a peer whose content hash differs.
    contentHash = await hashContent([bin]);
    const t0 = performance.now();
    runtime = await HostRuntime.open({ bin, scripts }, { tickRate, physicsBackend: arg('--physics'), logging: args.includes('--verbose') });
    log(`game loaded in ${Math.round(performance.now() - t0)} ms: scene "${runtime.sceneName}", ${[...runtime.scene.nodes].length} nodes, physics ${runtime.engine.physics.backend}`);
    runtime.onSceneStarted = (name) => log(`scene "${name}" started`);
}

// ----- the session -----------------------------------------------------------------------------------------------

const session = new HostSession({ contentHash, tickRate, maxPeers: Number(arg('--max-peers', '16')) });
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

// Tick 0 of the game is tick 0 of the session clock, so a tick number means the same moment to both.
if (runtime) {
    runtime.start(performance.now() - session.timeMs());
    let last = 0;
    runtime.onTick = (tick) => {
        if (tick - last < tickRate * 10) return;
        last = tick;
        const s = runtime!.stats();
        const peers = [...session.peers.values()].map((p) => `${p.id}:${p.connected ? p.linkKind : 'held'}`).join(' ') || 'none';
        log(`tick ${tick}: ${s.meanMs} ms mean, ${s.p95Ms} p95, ${s.maxMs} max (budget ${Math.round(1000 / tickRate)}), skipped ${s.skipped}; peers ${peers}`);
    };
}

console.log(`cleo-host (NetSync phase 2)
  WebTransport  udp/${listener.webTransportPort}  /netsync   cert sha-256 ${certificate.hash} (expires ${certificate.notAfter})
  WebSocket     tcp/${listener.webSocketPort}  /ws
  Endpoint      http://localhost:${listener.webSocketPort}/endpoint  (a HostEndpoint for PeerSession.join)
  Session       ${session.tickRate} Hz, ${session.maxPeers} seats, content ${contentHash.slice(0, 16)}…
  Game          ${runtime ? `"${runtime.sceneName}" running headless` : 'none (session only)'}`);

const shutdown = async (signal: string) => {
    log(`${signal}: closing`);
    runtime?.dispose();
    session.close('host shutting down');
    await new Promise((r) => setTimeout(r, 300));
    await listener.close();
    process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
