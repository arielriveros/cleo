# NetSync phase 0 — link spike

Throwaway spike for [docs/design/netsync.md](../../docs/design/netsync.md) §4.5 / §10 phase 0. It answers:
can a Node host speak WebTransport (datagrams + streams) to every target browser with a pinned
self-signed certificate, and does the WebSocket fallback take over cleanly? Nothing here is engine code; the
real link layer is built in phase 1 (`src/netsync/link/`).

## Run

```sh
cd tools/netsyncSpike
npm install
npm run selftest   # Node peer → in-process host: WebTransport, forced WebSocket, UDP "blocked" → fallback
npm run host       # then open http://localhost:4480/ and press a Run button
```

- **This machine:** `http://localhost:4480/` (`localhost` is a secure context, so WebTransport is allowed).
- **Other devices on the LAN (phones, Macs):** `https://<this machine's IP>:4481/`. Accept the self-signed
  certificate warning once; WebTransport itself is pinned by hash and needs no warning. Allow UDP 4433 and TCP
  4480/4481 through the Windows firewall if the device cannot connect.
- Each run is saved to `results/` (git-ignored) and printed in the host's console.
- `?run=auto|ws|blocked` on the page URL runs a mode immediately (used for automation).

Ports: UDP 4433 WebTransport, TCP 4480 HTTP + `ws://`, TCP 4481 HTTPS + `wss://`. 8080 is avoided on purpose:
the editor's dev server uses it.

## What it measures

| Test | What |
|---|---|
| `handshake` | hello / welcome on the control lane |
| `controlRtt` | 20 sequential echoes on the control lane |
| `datagramPing` | 100 pings at 30 Hz on the pulse lane → RTT and loss |
| `hostPulses` | host sends 150 × 1000-byte datagrams at 30 Hz → loss, reordering, spacing |
| `datagramSizes` | peer sends datagrams of 200–2000 bytes → which sizes reach the host |
| `bulkWithControl` | 2 MB on the bulk lane while echoing on the control lane → does bulk stall control? |

## Results (2026-11-19, Windows 11 host, same machine, Node 24.13, `@fails-components/webtransport` 1.6.12)

| Peer | Link | `maxDatagramSize` | Datagram writer API | Largest peer→host datagram | Notes |
|---|---|---|---|---|---|
| Node (library client) | WebTransport | — | `createWritable()` | 1200 | all tests pass; fallback by timeout works |
| Chrome 157 (headless) | WebTransport | 1211 | `writable` | 1200 | works once the host binds `::` (see below) |
| Edge 157 (headless) | WebTransport | 1211 | `writable` | 1200 | same as Chrome |
| Electron 31.7 / Chromium 126 (desktop shell) | WebTransport | 1024 | `writable` | 1200 | desktop builds work |
| Firefox 152 | WebTransport | 1024 | `writable` | 1200 | hash-pinned self-signed cert accepted on localhost |
| Playwright WebKit 26.5 **on Windows** | WebSocket (fallback) | — | `createWritable()` only | — | WT handshake fails at once; not representative of Safari (different network stack) |
| Safari 26.4+ on macOS / iOS | **not tested yet** | | | | needs a real Apple device on the LAN |

WebSocket (forced, and fallback after a WebTransport failure) passed every test in every browser.

## Findings that change the design

1. **Bind the host dual-stack (`::`), not `0.0.0.0`.** Chrome resolves `localhost` to `::1` first and its QUIC
   handshake fails without trying IPv4 ("Opening handshake failed"). Production hosts must listen on IPv6
   as well, or peers must be given an IP literal.
2. **Datagram writer API differs by engine.** Chromium and Firefox expose `datagrams.writable`; WebKit (and the
   Node library) expose `createWritable()` — WebKit has *no* `writable`. The link must try `createWritable()`
   first and fall back to `writable`. This is the "Safari outgoing datagrams" report from research: the API
   is there, just under the newer name.
3. **Keep pulse datagrams ≤ 1000 bytes.** `maxDatagramSize` is 1024 in Firefox and Chromium 126 and 1211 in
   Chromium 157; oversize datagrams are dropped silently (the Node host delivered 1200 and lost 1250+). A
   1000-byte payload budget fits everywhere with room for a header. (Plan §4.2 said "≈1200"; use 1000.)
4. **Never use `setInterval` for the host tick.** On Windows, timers round to ~15.6 ms, so `setInterval(33.3)`
   ran at ~21 Hz (47 ms). A deadline-driven loop (run every tick whose time has come, then sleep to the next
   deadline) kept 30 Hz on average. Dev hosts run on Windows (editor Play), so `HostRuntime` needs this.
5. **Fallback detection splits into fast and slow failures.** A closed port fails at once ("Opening handshake
   failed"); a network that silently drops UDP only fails at the timeout. Both fall back correctly; the
   2.5 s timeout is the cost a UDP-blocked player pays once per session.
6. **Bulk on its own stream does not stall control much** on loopback (control RTT max 12–18 ms during a 2 MB
   transfer over WebTransport). Over WebSocket the same transfer pushed control RTT to ~40 ms in Edge and
   Firefox — the head-of-line effect the plan expects, bounded by the 64 KB queue limit.
7. **The Linux prebuilt binary needs glibc ≥ 2.38.** In `node:24-slim` (Debian bookworm, glibc 2.36) the
   HTTP/3 addon fails to load and only WebSocket works. In `node:24-trixie-slim` (Debian 13, glibc 2.41) the
   self-test passes all three cases. The host container image must be based on trixie (or Ubuntu 24.04+), and
   the plain Node bundle must document the glibc floor.
8. **Library ergonomics:** the HTTP/3 binary is a separate package
   (`@fails-components/webtransport-transport-http3-quiche`, prebuilt for Windows/Linux/macOS x64 and
   Linux/macOS arm64); it installed without a compiler on Windows. Server API (`Http3Server`,
   `sessionStream(path)`, standard WebTransport session objects) was enough for everything here.

## Still open for phase 0

- [ ] Safari on macOS 26.4+ and iOS 26.4+ over the LAN page (`https://<ip>:4481/`).
- [ ] A real network: host on a Linux VPS, peer on Wi-Fi / mobile, with real loss and RTT.
- [ ] A network that blocks UDP (or a firewall rule dropping UDP 4433) to confirm the timeout path in a browser.
- [x] Linux host: self-test passes in `node:24-trixie-slim` (fails to load the addon in `node:24-slim`).
- [ ] Linux arm64 host.
