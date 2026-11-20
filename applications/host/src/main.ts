// cleo-host (docs/design/netsync.md §7): a NetSync dedicated host. Runs a game headless at a fixed tick rate and
// accepts players over WebTransport and WebSocket. Every setting is a flag or an environment variable (the host
// contract, settings.ts); the game's own NetSync settings fill in the rest.
//
//   npm start -- --game path/to/game.bin [--scripts path/to/game.scripts.js]
//   npm start -- --example ../editor/public/examples/sandbox --serve      (development: publish, host and serve it)
//   npm start                                                              (no game: a session only)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedCertificate, generateCertificate } from './devCertificate';
import { HostApp, createLog } from './hostApp';
import { readSettings } from './settings';

const here = path.dirname(fileURLToPath(import.meta.url));
const settings = readSettings(process.argv.slice(2), process.env);
const log = createLog(settings.log);

// Development keeps one certificate for its 14 days (a browser tab can be reloaded against the same hash); a
// deployed host makes its own each start (it lives for a session, and its hash goes out with the allocation).
const certificate = settings.example ? await cachedCertificate(path.join(here, '..', '.cache')) : await generateCertificate();

const app = await HostApp.start(settings, { certificate, log });
const { listener } = app;

if (settings.log === 'text') {
    console.log(`cleo-host
  WebTransport  udp/${listener.webTransportPort}  /netsync   cert sha-256 ${certificate.hash} (expires ${certificate.notAfter})
  WebSocket     tcp/${listener.webSocketPort}  /ws
  Control       ${app.controlPort ? `http://localhost:${app.controlPort}  /healthz /readyz /status /cert-hash, POST /allocate` : 'off'}
  Session       ${app.session.tickRate} Hz, ${app.session.maxPeers} seats, ${app.state}${app.sessionSpec ? ` (${app.sessionSpec.id})` : ''}, lifecycle ${app.lifecycle.name}${settings.tokenKey ? ', join tokens required' : ''}
  Game          ${app.runtime ? `"${app.runtime.sceneName}" running headless` : 'none (session only)'}`);
    if (app.web) {
        const q = new URLSearchParams({
            wt: `https://localhost:${listener.webTransportPort}/netsync`, hash: certificate.hash, ws: `ws://localhost:${listener.webSocketPort}/ws`,
        });
        console.log(`  Play          http://localhost:${listener.webSocketPort}/?${q}
                (add &transport=websocket to play over the fallback)`);
    }
} else {
    log('info', 'started', {
        udpPort: listener.webTransportPort, tcpPort: listener.webSocketPort, controlPort: app.controlPort,
        certHash: certificate.hash, state: app.state, session: app.sessionSpec?.id, lifecycle: app.lifecycle.name,
    });
}

// SIGTERM is the platform's "drain": no new players, end the session, exit within the grace. A second signal (or
// Ctrl+C) stops at once.
let stopping = false;
const stopNow = async (signal: string) => {
    log('info', `${signal}: stopping`);
    await app.close();
    process.exit(0);
};
process.on('SIGTERM', () => {
    if (stopping) return void stopNow('SIGTERM');
    stopping = true;
    app.drain('SIGTERM');
});
process.on('SIGINT', () => void stopNow('SIGINT'));
