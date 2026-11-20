# Hosting an online game

An online Cleo game ([Multiplayer](../editor/multiplayer.md)) runs on **dedicated hosts**: a host is a Node
process, `cleo-host`, that runs the game for one session (a match) of up to 16 players. Cleo does not choose where
hosts run; you do. Everything Cleo ships runs on any provider, and the few provider-specific parts are adapters you
name in configuration. The reasoning is in [the design](../design/netsync.md) (§7).

## The pieces

| | What it is | Must be reachable on |
|---|---|---|
| **Host** (`cleo-host.mjs`) | Runs the game headless for one session. | UDP (WebTransport, any port); TCP (WebSocket, from the gateway); a private control port |
| **Allocator** (`cleo-allocator.mjs`) | Hands a player a **join ticket**: which host, its certificate hash, a signed join token. Gets hosts from a **fleet**. | HTTPS (players' pages call `POST /join`) |
| **Gateway** (built into the allocator) | The WebSocket fallback's one entry: `wss://play.example.com/s/<session>` forwarded to the session's host. | TCP 443 with a real certificate for your domain |

Players reach hosts over **WebTransport** directly (UDP, with a certificate the host makes and the ticket pins by
its hash: no domain per host). Where a network blocks UDP they fall back to **WebSocket** through the gateway, on
443. The allocator and gateway are the only piece that stays up between matches.

## Where to run hosts

| | Examples | For |
|---|---|---|
| **One VPS** (or a few) | Hetzner, OVH, Vultr, DigitalOcean | Start here: cheapest per match (traffic is the cost that matters, and many VPS providers include it), simplest. Fixed capacity; you place regions by hand. |
| **Managed game-server hosting** | Edgegap | A host per match near its players, global, scales to zero. Pay per vCPU-minute and per GB. |
| **Kubernetes + Agones** | Agones on any cluster | A team that already runs Kubernetes. |
| General app platforms, edge workers | Fly.io, Cloud Run, Cloudflare Workers | **Not for hosts**: no QUIC, or no long-running simulation. Fine for a lobby. |

Check providers' current prices before choosing; they change.

## Publishing the host

```sh
npm run build:host
npm run publish-host -- --game <Publish › Web's folder> --out <folder>
```

The folder holds the built host and allocator, the game (the web build's own `game.bin`, so players and host
agree on its content hash), a `Dockerfile` (`node:24-trixie-slim`: the WebTransport addon needs glibc 2.38 or
newer, on amd64 or arm64), and a starting point for each option:

| Option | Start from | Fleet | Host lifecycle |
|---|---|---|---|
| One VPS, Docker | `docker-compose.yml`, `netsync.hosting.json`, `.env.example` | `static` | `none` |
| One VPS, no Docker | `deploy/cleo-host@.service` (systemd) | `static` | `none` |
| A Docker host, a container per match | the image | `docker` | `none` |
| Kubernetes + Agones | `deploy/agones-fleet.yaml` | `agones` | `agones` |
| Edgegap | `deploy/edgegap.md` | `edgegap` | `edgegap` |

Moving to another provider is another template and two adapter names: the image and the game stay the same.

## One VPS, step by step

1. A VPS with Docker, a domain pointing at it (`play.example.com`), and a certificate for it in `tls/`
   (`fullchain.pem`, `privkey.pem`; Let's Encrypt's certbot makes them).
2. In the published folder: `docker compose build`, then
   `docker compose run --rm allocator node cleo-allocator.mjs --keys`, and put the two keys and the VPS's address
   in `.env` (see `.env.example`).
3. In `netsync.hosting.json`, set `gatewayUrl` to `wss://play.example.com` and each host's `publicAddress` to the
   VPS's address.
4. `docker compose up -d`. Open UDP 4433–4434 and TCP 443 in the firewall; keep 4480 and 4490 closed.
5. In the editor, **Options › Project › NetSync**: turn on **Online play** and set **Allocator** to
   `https://play.example.com`. Publish › Web, and put the web build anywhere (the same VPS behind a web server, or
   a static host).

Two hosts take two matches at once; add a block to `docker-compose.yml` and a line to `netsync.hosting.json` for
each more. A host needs about one vCPU while its match runs.

## The host's settings

Every setting is a flag or an environment variable (what platforms set); what neither sets comes from the game's
**Options › Project › NetSync**, then the default. `node cleo-host.mjs --help` lists them all. The main ones:

| Environment | Default | |
|---|---|---|
| `NETSYNC_GAME`, `NETSYNC_SCRIPTS` | — | the game (`game/game.bin`, `game/game.scripts.js` in the image) |
| `NETSYNC_UDP_PORT`, `NETSYNC_TCP_PORT`, `NETSYNC_CONTROL_PORT` | 4433, 4480, 4490 | WebTransport, WebSocket, control (`off` for none) |
| `NETSYNC_PUBLIC_ADDRESS` | — | the address players reach this host at |
| `NETSYNC_SESSION` | — | `{"id", "scene"?, "mode"?, "maxPeers"?}`: start with this session |
| `NETSYNC_AWAIT_ALLOCATION=1` | off | a warm host: no session until one is allocated |
| `NETSYNC_REUSE=1` | off | after a session, reset and wait for the next instead of exiting |
| `NETSYNC_TOKEN_KEY` | — | the allocator's public key: players need a join token |
| `NETSYNC_LIFECYCLE` | `none` | `none`, `agones` or `edgegap` |
| `NETSYNC_DRAIN_SECONDS`, `NETSYNC_EMPTY_SECONDS`, `NETSYNC_JOIN_SECONDS` | 30, 30, 120 | grace periods (below) |
| `NETSYNC_LOG=json` | text | one JSON object per line, for a log collector |
| `NETSYNC_CACHE` | `.cache` beside the host | development (`--dev`, `--example`): where the certificate is kept across restarts |

**A session's life.** A host with a session takes players until everyone has left (for `NETSYNC_EMPTY_SECONDS`),
or ends it when nobody came (`NETSYNC_JOIN_SECONDS`); then it exits — the platform starts a fresh one — or, with
`NETSYNC_REUSE`, reloads its first scene and waits for the next. A host started with no session and not waiting
for one opens one at once and keeps it open: a plain always-on server.

**SIGTERM** (a platform stopping the host, `docker stop`) drains: no new players, the session ends when they have
left or after `NETSYNC_DRAIN_SECONDS`, then the host exits.

**The control port** is the platform's, not the players': keep it private. `GET /healthz` (alive), `GET /readyz`
(can take a session or players), `GET /status` (state, session, players, tick timings, traffic;
`?format=prometheus` for Prometheus), `GET /cert-hash`, and `POST /allocate` with a session (a warm host takes it;
`NETSYNC_CONTROL_SECRET` makes it ask for a bearer token).

## The allocator

`netsync.hosting.json` configures it (the published folder has one for a single VPS). Its parts:

- `fleet` — where hosts come from: `static` (a list of warm hosts, each with `name`, `control`, `publicAddress`
  and `privateAddress`), `docker` (`image`, `publicAddress`, the Docker API), `agones` (`fleet`, `namespace`),
  `edgegap` (`application`, `version`; the API token in `NETSYNC_EDGEGAP_TOKEN`).
- `gatewayUrl` — its own public `wss://` address; `tls` — its certificate (or run it behind a TLS proxy).
- `maxPeers` and `modes` — players per session, per mode:
  `{"coop": {"maxPeers": 8}, "deathmatch": {"scene": "Arena"}}`.
- `hooks` — a module of yours: `onRequest(join, req)` refuses a join (return a reason) or changes it — accounts,
  bans and matchmaking rules stay in your backend — and `chooseRegion(join, req)`.

`POST /join` with `{"mode"?, "region"?, "name"?, "session"?}` answers a ticket `{endpoint, token, session}`. A
session of that mode with a free seat is filled before a new host is started. The published page does this itself
when the project names an **Allocator**; a page opened at `?join=<ticket JSON>` joins that ticket's host directly.

**Join tokens** are what stop anyone from walking into a host: the allocator signs `{session, expiry, name}` with
its private key (`NETSYNC_TOKEN_PRIVATE_KEY`); every host checks it with the public one (`NETSYNC_TOKEN_KEY`). A
token admits its holder to its own session, for a minute.
