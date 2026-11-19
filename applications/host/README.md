# cleo-host

The NetSync dedicated host ([docs/design/netsync.md](../../docs/design/netsync.md)). A Node process that accepts
peers over **WebTransport** (UDP) and the **WebSocket fallback** (TCP) and runs a session for them.

**Phase 1 (now):** links and sessions only — peers join, are seated, keep their clock in step with the host, drop
and reconnect into the same seat. There is no game behind it yet; phase 2 adds the headless scene.

## Run

```sh
npm run host:install          # from the repo root, once (native WebTransport addon, ws, cert tooling)
npm run host                  # starts on UDP 4433 (WebTransport) and TCP 4480 (WebSocket + HTTP)
npm run host -- --wt-port 4433 --ws-port 4480 --tick-rate 30 --max-peers 16 --content dev
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
| `src/main.ts` | The CLI. |

## Platform notes (from the phase-0 spike)

- Binds `::` (IPv6 + IPv4). Chrome resolves `localhost` to `::1` first and does not retry IPv4 for QUIC.
- Linux needs glibc ≥ 2.38 for the prebuilt WebTransport addon: use `node:24-trixie-slim`, not `node:24-slim`.
- The WebSocket side is plain `ws://`. In production it sits behind the gateway, which terminates TLS on 443.
