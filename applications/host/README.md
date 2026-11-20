# cleo-host

The NetSync dedicated host ([docs/design/netsync.md](../../docs/design/netsync.md)). A Node process that accepts
peers over **WebTransport** (UDP) and the **WebSocket fallback** (TCP) and runs a session for them.

**Phase 2 (now):** the host runs a game headless — a published `game.bin` (or, for development, an example
project folder) on an engine with no renderer, at a fixed tick rate — and peers join a session beside it: they
are seated, keep their clock in step with the host's ticks, drop and reconnect into the same seat. Phase 3 sends
them the game's state.

## Run

```sh
npm run host:install          # from the repo root, once (native WebTransport addon, ws, cert tooling)
npm run host -- --game path/to/game.bin           # a published game (game.scripts.js beside it is picked up)
npm run host -- --example ../editor/public/examples/firing-line   # an example folder, packed on the fly
npm run host -- --example ../editor/public/examples/sandbox --player-template Player   # each peer drives a Player
npm run host                                       # no game: a session only
#   options: --wt-port 4433 --ws-port 4480 --tick-rate 30 --max-peers 16 --physics jolt|rapier|cannon --verbose
npm run host:test             # integration tests over real sockets
```

`GET http://localhost:4480/endpoint` returns the `HostEndpoint` a peer passes to `PeerSession.join()`:

```ts
import { PeerSession } from 'src/netsync';
const endpoint = await (await fetch('http://localhost:4480/endpoint')).json();
const session = await PeerSession.join({ endpoint, contentHash: 'dev', name: 'me' });
session.hostTick();      // the host's current tick, from this peer's clock estimate
session.linkKind;        // 'webtransport', or 'websocket' (see session.fallbackReason)
```

## What is where

| | |
|---|---|
| `src/netsync/` (engine) | Everything that runs in browsers too: links (`WebTransportLink`, `WebSocketLink`, loopback, conditioned), `connect()` with fallback, `HostSession`, `PeerSession`, `ClockSync`, `FixedTicker`. |
| `src/hostListener.ts` | The Node-only part: an HTTP/3 server (`@fails-components/webtransport`) and a WebSocket server (`ws`), each new connection wrapped as a `NetLink` and handed to `HostSession.accept()`. |
| `src/devCertificate.ts` | Self-signed ECDSA P-256 certificate valid 10 days (browsers pin it by hash, which requires ≤ 14 days and no RSA). Cached in `.cache/`. |
| `src/hostRuntime.ts` | Loads a game.bin with the browser player's own loader (`applications/editor/src/player/gameContent.ts`) onto a headless `CleoEngine` (`headless: true`, a `NullDevice`), runs extracted scripts from game.scripts.js, and steps it with a deadline-driven `FixedTicker`. Per-tick timings in `stats()`. |
| `src/exampleGame.ts` | Packs an example project folder into a game.bin the way Play in window does (scenes, baked templates, script modules, shared clips), for development and tests. |
| `src/main.ts` | The CLI. |

## Platform notes (from the phase-0 spike)

- Binds `::` (IPv6 + IPv4). Chrome resolves `localhost` to `::1` first and does not retry IPv4 for QUIC.
- Linux needs glibc ≥ 2.38 for the prebuilt WebTransport addon: use `node:24-trixie-slim`, not `node:24-slim`.
- The WebSocket side is plain `ws://`. In production it sits behind the gateway, which terminates TLS on 443.
