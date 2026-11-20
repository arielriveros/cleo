# cleo-host

The NetSync dedicated host ([docs/design/netsync.md](../../docs/design/netsync.md)). A Node process that runs a
game headless — a published `game.bin` on an engine with no renderer, at a fixed tick rate — and the session its
players join over **WebTransport** (UDP) and the **WebSocket fallback** (TCP). One process, one session.

## Run

```sh
npm run host:install          # from the repo root, once (native WebTransport addon, ws, cert tooling)
npm run build:player          # once, for --serve: the published player

# Development: publish an example as a web game, host it, serve it, print a link that opens it joined.
npm run host -- --example ../editor/public/examples/sandbox --serve --player-template Player --spawn 30,0.05,-30

npm run host -- --game path/to/game.bin           # a published game (game.scripts.js beside it is picked up)
npm run host                                       # no game: a session only
npm run host:test                                  # integration tests over real sockets
```

## The host contract

Everything a hosting platform needs to run cleo-host, and all it gives back (§7.2). Every setting is a flag or an
environment variable; what neither sets comes from the game's own `config.netsync` (Project › NetSync), then the
default. The full table is at the top of [src/settings.ts](src/settings.ts).

| Environment | Flag | Default | |
|---|---|---|---|
| `NETSYNC_GAME`, `NETSYNC_SCRIPTS` | `--game`, `--scripts` | — | the published game |
| `NETSYNC_UDP_PORT` | `--wt-port` | 4433 | WebTransport |
| `NETSYNC_TCP_PORT` | `--ws-port` | 4480 | WebSocket (the gateway forwards `wss://…/s/<session>` here) |
| `NETSYNC_CONTROL_PORT` | `--control-port` | 4490 | HTTP control; `off` for none. Keep it private. |
| `NETSYNC_PUBLIC_ADDRESS` | `--public-address` | request's Host | the address players reach this host at |
| `NETSYNC_SESSION` | `--session` | — | `{"id", "scene"?, "mode"?, "maxPeers"?}`: start allocated |
| `NETSYNC_AWAIT_ALLOCATION=1` | `--await-allocation` | off | a warm host: no session until `POST /allocate` |
| `NETSYNC_TOKEN_KEY` | `--token-key` | — | the allocator's Ed25519 public key (PEM or base64 DER): join tokens required |
| `NETSYNC_LIFECYCLE` | `--lifecycle` | none | `none` or `agones` |
| `NETSYNC_REUSE=1` | `--reuse` | off | after a session, reset and wait for the next instead of exiting |
| `NETSYNC_DRAIN_SECONDS`, `NETSYNC_EMPTY_SECONDS`, `NETSYNC_JOIN_SECONDS` | `--drain-seconds`… | 30, 30, 120 | grace periods |
| `NETSYNC_LOG=json` | `--log json` | text | one JSON object per line |
| `NETSYNC_TICK_RATE`, `NETSYNC_MAX_PEERS`, `NETSYNC_PLAYER_TEMPLATE`, `NETSYNC_SPAWN`, `NETSYNC_TRUST` | `--tick-rate`… | the game's | |

**Control port (HTTP):** `GET /healthz` (alive), `GET /readyz` (can take a session or players; 503 while
draining), `GET /status` (state, session, peers, tick timings, bytes; `?format=prometheus`), `GET /cert-hash`,
`POST /allocate` with a session spec (409 when this host already has one; `NETSYNC_CONTROL_SECRET` makes it ask for
`Authorization: Bearer <secret>`).

**A session's life:** `ready` → `allocated` (a session assigned) → `running` (players in it) → `ended` (everyone
left for `--empty-seconds`, or nobody came within `--join-seconds`) → the host exits, or with `--reuse` resets its
scene and is `ready` again. A host started with neither a session nor `--await-allocation` opens one at once and
keeps it open: a plain long-running server.

**SIGTERM** drains: no new players, the session ends when they have left or after `--drain-seconds`, then exit. A
second SIGTERM or SIGINT stops at once.

**Join tokens:** the allocator signs `{sid, exp, name?}` with its Ed25519 private key; the host checks the
signature, the expiry and that `sid` is its session. Host and allocator never call each other. See
[src/joinToken.ts](src/joinToken.ts).

**Lifecycle adapters:** `none` (VPS, Docker, Edgegap: the control port is enough) and `agones` (the Agones SDK's
REST sidecar: Ready, Health, the allocation from `GET /watch/gameserver` — its session from the GameServer's
`netsync.session` annotation — and Shutdown when the session ends). See [src/lifecycle.ts](src/lifecycle.ts).

**Possession:** a joining player gets a character the level placed for a player while one is free, then a new
copy of the player template at the spawn point. A copy goes when its player leaves; a level character waits for the
next one.

## What is where

| | |
|---|---|
| `src/netsync/` (engine) | Everything that runs in browsers too: links, `connect()` with fallback, sessions, clock, sync, prediction, the browser client (`NetSyncClient`). |
| `src/hostApp.ts` | The host as a whole: the game, the session and everything that plays it with the peers, the session's life, the control port. |
| `src/settings.ts` | Flags, environment and the game's config, read once. |
| `src/hostListener.ts` | The Node-only transport: an HTTP/3 server (`@fails-components/webtransport`) and a WebSocket server (`ws`). |
| `src/hostRuntime.ts` | A game.bin on a headless `CleoEngine`, stepped by a deadline-driven `FixedTicker`. |
| `src/joinToken.ts`, `src/lifecycle.ts` | Join tokens; the `none` and `agones` lifecycle adapters. |
| `src/devCertificate.ts` | Self-signed ECDSA P-256 certificate (≤ 14 days, pinned by hash). Cached in `.cache/` in development; a new one each start otherwise. |
| `src/exampleGame.ts`, `src/webBuild.ts` | An example project folder packed (or published as a web game) the way the editor does, for development and tests. |
| `src/main.ts` | The CLI. |

## Platform notes

- Binds `::` (IPv6 + IPv4). Chrome resolves `localhost` to `::1` first and does not retry IPv4 for QUIC.
- Linux needs glibc ≥ 2.38 for the prebuilt WebTransport addon: use `node:24-trixie-slim`, not `node:24-slim`.
  linux/amd64 and linux/arm64 both load it.
- The WebSocket side is plain `ws://`. In production it sits behind the gateway, which terminates TLS on 443.
