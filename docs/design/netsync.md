# NetSync — online multiplayer for Cleo (plan)

Status: **phase 8 done** (phase 0 open: Safari; browser peer runtime open) · Transport: **WebTransport, WebSocket fallback** · Host: **dedicated only** ·
Target: **physics sandbox shooter — co-op PvE (≤ 50 AI) and 8v8 deathmatch with bots, ≤ 16 peers** ·
Started 2026-11-19

NetSync is how a Cleo game keeps several players' scenes in agreement over the network. One machine — the
**host** — runs the real game; every **peer** sends it commands and receives the state it needs to draw.

> **Naming.** The engine already uses *replication* for the physics worker copy (`src/physics/pal/replication.ts`,
> `WorldMirror` / `WorldReplica`, `replicaCodec.ts`). NetSync deliberately does **not** reuse those words, so a
> reader never confuses "the world copied to a worker thread" with "the world sent to another player".
> Avoid *replicate, replica, mirror* anywhere in NetSync code, docs and UI.

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **Host** | The process that runs the authoritative simulation: always a dedicated, headless Node process. No player hosts. |
| **Peer** | A connected player's game client. Has a `PeerId` (small integer, 0 = host). |
| **Link** | One transport connection between a peer and the host (`NetLink`): a WebTransport session, or a WebSocket when WebTransport is unavailable. |
| **Carry** | A peer temporarily drives a prop it is holding; the host accepts its state within limits and sends it to everyone else (§6.4.2). |
| **Shot** | A weapon fire event, stamped with the shooter's view tick, that the host checks against rewound hitboxes (§6.5.1). |
| **Lane** | A channel inside a link: `control` (reliable, ordered stream), `bulk` (reliable stream for large one-offs), `pulse` (unreliable datagrams). |
| **Tick** | One fixed simulation step on the host (default 30 Hz). Everything in NetSync is stamped with a tick. |
| **NetId** | The small integer that names a synced node on the wire. Maps to the node's uuid. |
| **Synced node** | A node whose state the host sends to peers. Opt-in, per node (inspector) or per script (`@synced`). |
| **Sync field** | One value the host keeps peers up to date with: a transform, a body velocity, a `@synced` script field. |
| **Pulse** | The host → peer state packet for one tick (sync fields that changed against the peer's acknowledged baseline). Sent on the `pulse` lane. |
| **Baseline** | The last pulse a peer acknowledged. The host encodes each new pulse as a delta from it. |
| **Command** | A peer → host packet holding the player's `ControlIntent` for one tick (plus a few earlier ones for loss cover). |
| **NetCall** | A method call sent across the network (`@netcall`). What other engines call an RPC. |
| **Owner** | The peer that drives a node (its player character). The owner *predicts* it; everyone else *follows* it. |
| **Predict / Correct** | The owner moves its own character immediately from its commands, then corrects when the host's pulse disagrees. |
| **Follow** | How a peer draws a node it does not own: smoothly, a little in the past, between the two pulses around the render time. |
| **Scope** | Which synced nodes a peer receives (distance, room, team). Out-of-scope nodes are despawned on that peer. |

## 2. Goals and non-goals

**Target game (v1 tuning).** A physics sandbox with shooter elements: players move around a world full of
dynamic props, pick up and throw them, blow them up, and shoot AI enemies and objects. Two modes size the
design:

| Mode | Players | AI | Trust |
|---|---|---|---|
| **Co-op PvE** (horde style: a few players against waves of enemies) | 8 typical, 16 max | up to 50 alive at once | `coop` |
| **Deathmatch** (8v8, empty slots filled by bots — e.g. 2 players + 14 AI) | up to 16 total, humans + bots | bots fill the teams | `versus` |

**Trust** is a session setting the host enforces. `coop` validates carried props and shot claims loosely
(favour the shooter, accept carried poses within limits). `versus` checks shots only against the host's own
rewound raycast (no claimed-hit tolerance), validates carried poses strictly and rate-limits commands, because
players can hurt each other. The host decides every outcome in both.

**Goals (v1)**
- Host-authoritative sessions for up to 16 peers (8 typical) and up to 50 AI characters, over WebTransport
  with an automatic WebSocket fallback, in browser and desktop builds alike.
- A dedicated host that runs a published game's scenes headless in Node.
- Player characters that feel immediate (predict / correct), everyone else smooth (follow).
- Many physics props in motion at once within a bounded bandwidth budget (sleep skipping, priority, scope).
- Picking up / carrying / throwing props that feels local to the player doing it.
- Hitscan and projectile weapons that register where the shooter aimed, against AI and props.
- Scripting surface that fits the existing decorator style: `@synced`, `@netcall`, `this.net`.
- Editor: mark nodes synced, Play with N peers + a local host, simulated latency / loss.
- Single-player games and existing projects behave exactly as today when NetSync is off.

**Non-goals (v1)**
- Lockstep or rollback netcode (needs cross-machine determinism the engine does not have — §11).
- Listen hosts (a player's game acting as host) and peer-to-peer: hosts are always dedicated.
- Matchmaking, accounts, persistence services (use an external backend).
- Competitive anti-cheat beyond host authority and the `versus` checks (no client integrity checks).
- Destructible props (breaking into pieces). Not planned for v1; it would add spawn bursts to the budget.
- MMO scale (hundreds of players per host).

## 3. Architecture

```
 ┌──────────────── Peer (browser / Electron) ─────────────────┐        ┌──────────── Host (Node, headless) ────────────┐
 │ InputSystem → ControllerNode('player') → ControlIntent      │        │ HostRuntime: Scene + PhysicsSystem + AISystem │
 │        │                    │                               │        │   fixed tick (30 Hz)                          │
 │        │          Predictor (owner's pawn)                  │        │                                               │
 │        ▼                    ▲                               │        │ ControllerNode('remote') ← CommandQueue[peer] │
 │   CommandWriter ──────── pulse lane (datagrams) ───────────────────▶ CommandReader                               │
 │   PulseReader  ◀──────── pulse lane (datagrams) ──────────────────── PulseWriter (per-peer baseline + scope)     │
 │   ControlReader ◀──────── control lane (stream) ───────────────────▶ ControlWriter (spawn, despawn, netcalls,     │
 │        │                                                    │        │   on-change fields, session)                │
 │   Follower (interpolation buffer) → Scene (render)          │        │                                               │
 └─────────────────────────────────────────────────────────────┘        └───────────────────────────────────────────────┘
                 NetLink (WebTransport session) — one per peer
```

Three layers, each testable on its own:

1. **Link** (`src/netsync/link/`) — bytes in, bytes out, per lane. Peer side: `WebTransportLink`,
   `WebSocketLink`, and `connect()` which picks one (§4.6). Host side: `HostListener` accepting both kinds.
   Tests: `LoopbackLink` (in-process — the same idea as `LoopbackPort` in `src/physics/worker/ports.ts`), and
   a `ConditionedLink` wrapper that adds latency, jitter and loss — including a "TCP-like" mode that delays
   instead of dropping, to test the fallback's behaviour.
2. **Session** (`src/netsync/session/`) — handshake, protocol/version/content-hash check, `PeerId`
   assignment, clock sync, tick alignment, keep-alive, disconnect / reconnect.
3. **Sync** (`src/netsync/sync/`) — NetIds, spawn / despawn, sync fields, pulses, commands, netcalls,
   scope, predict / correct, follow.

NetSync ships as an **optional engine feature** (`src/modules/netsync/`, a `FeatureDef` in
`src/modules/catalog.ts`, group `gameplay`), so a game that does not use it does not download it.

## 4. Transport: WebTransport

### 4.1 Why
Unreliable, unordered datagrams for the per-tick traffic (a lost pulse is replaced by the next one; TCP's
head-of-line blocking is what makes WebSocket games stutter under loss), plus reliable streams for
everything that must arrive, all in one QUIC connection with one handshake and connection migration
(Wi-Fi → mobile keeps the session). Baseline in all major browsers since March 2026 (Safari 26.4). Electron
builds get it from Chromium.

### 4.2 Lanes

| Lane | WebTransport primitive | Carries | Ordering |
|---|---|---|---|
| `control` | 1 bidirectional stream, opened by the peer at connect | handshake, spawn / despawn, on-change sync fields, netcalls (reliable), scope changes, session events | reliable, ordered |
| `bulk` | short-lived unidirectional streams, one per transfer | the join baseline (full scene state), large netcall payloads | reliable; independent of `control`, so a big join snapshot never stalls gameplay messages |
| `pulse` | datagrams | pulses (host → peer), commands and acks (peer → host), unreliable netcalls | none — every datagram is self-contained |

- **Stream framing:** `u32 length | u8 type | payload`. One reader loop per stream.
- **Datagram size:** budget **1000 bytes** per datagram payload. Measured `maxDatagramSize` is 1024 in
  Firefox 152 and Chromium 126 (Electron 31) and 1211 in Chromium 157; oversize datagrams are dropped
  silently (phase-0 spike). Use `min(1000, maxDatagramSize − header)`. There is no fragmentation: a pulse that does not fit is split into several self-contained datagrams by node
  group, highest priority first; whatever does not fit this tick is carried by the next (priority
  accumulates with age — §6.6).
- **Datagram header:** `u16 protocolTag | u32 tick | u32 baselineTick | u16 ackBits…` (exact layout in
  phase 2).

### 4.3 Host library
- **Chosen for v1:** [`@fails-components/webtransport`](https://www.npmjs.com/package/@fails-components/webtransport)
  — HTTP/3 + WebTransport for Node via libquiche, with datagram and stream support. It is what MDN lists for
  Node, and it keeps the whole host in TypeScript next to the engine.
- **Risk:** native addon, largely one maintainer, Node has no built-in WebTransport. **Mitigation:** the host
  only sees `NetLink`. If the library fails us, swap in a sidecar (Rust `wtransport` or Go `webtransport-go`)
  that terminates QUIC and talks to the Node host over a local socket — no NetSync code changes.
- **Protocol token:** browsers still send the legacy `:protocol = webtransport`; make sure the host accepts
  it (some newer servers only accept draft-15's `webtransport-h3`).

### 4.4 Certificates
- **Production:** the same pinned-hash scheme, with the hash handed to peers by the allocator (§7.1), so
  hosts need no domain of their own. A host *may* use a CA certificate instead when it has a stable domain.
  The WebSocket fallback always goes through the gateway's real certificate (§7.1).
- **Development / editor / LAN:** the host generates a self-signed **ECDSA P-256** certificate valid for
  **≤ 14 days** at startup, and the peer passes its SHA-256 to
  `new WebTransport(url, { serverCertificateHashes: [{ algorithm: 'sha-256', value }] })`. The editor gets
  the hash from the host it launched; a published game gets it from a small HTTPS endpoint
  (`/netsync/cert-hash`) or the matchmaker. RSA keys are rejected by the API.
- **Known issue:** Firefox has had regressions with `serverCertificateHashes`; test Chrome, Edge, Safari and
  Firefox in phase 1 and document per-browser setup.

### 4.5 Phase-0 spike checklist
Spike and full results: [tools/netsyncSpike/README.md](../../tools/netsyncSpike/README.md).
- [x] Chrome 157, Edge 157, Firefox 152 connect to the Node host with a hash-pinned self-signed cert
      (2026-11-19, localhost).
- [ ] Safari 26.4+ on macOS and iOS — needs a real Apple device (Playwright's Windows WebKit build is not
      representative: its WebTransport handshake always fails).
- [x] Datagrams both directions in Chrome, Edge, Firefox, Electron and the Node client. The "Safari has no
      outgoing datagram writer" report is an API-name difference: WebKit only has `createWritable()`, while
      Chromium and Firefox only have `writable`. The link tries `createWritable()` first.
- [x] `maxDatagramSize` per browser (1024 / 1211) → 1000-byte budget (§4.2).
- [ ] Round-trip time and behaviour under real loss (needs a VPS host and a Wi-Fi / mobile peer).
- [x] Electron 31 (desktop build) connects over WebTransport.
- [x] Prebuilt addon installs without a compiler on Windows x64 and Linux x64. Linux needs glibc ≥ 2.38:
      base the host image on `node:24-trixie-slim` (the bookworm-based `node:24-slim` cannot load it).
      [ ] Linux arm64.
- [x] WebSocket fallback: forced, closed port (fails at once) and silently dropped UDP (fails at the
      timeout) all fall back and pass every test.
- Findings for later phases: bind the host to `::` (Chrome tries `::1` for `localhost` and does not retry
  IPv4); the host tick must be deadline-driven, not `setInterval` (Windows timers ran a 30 Hz interval at
  ~21 Hz).

### 4.6 WebSocket fallback (v1)
Who needs it: networks that block UDP (corporate, school, some hotel and mobile networks), Safari on
iOS / macOS older than 26.4, and any browser where the phase-0 spike finds a WebTransport gap.

**Choosing a link.** `connect()` tries WebTransport first and falls back to WebSocket when:
- `typeof WebTransport === 'undefined'`;
- the WebTransport session is not `ready` within ~2.5 s (UDP silently dropped is the common failure);
- the session closes during the handshake.
The choice is remembered per host for the browser session (try WebTransport again next visit). The game can
read `net.linkKind` ('webtransport' | 'websocket') — e.g. to show a "limited connection" hint.

**Host side.** Each host listens on one UDP port (WebTransport) and one TCP port (WebSocket, Node `ws`
package). Peers never reach the TCP port directly in production: they connect to the **gateway** at
`wss://<region>.yourgame.com/s/<sessionId>` on TCP 443 with a real certificate, which forwards to the host
(§7.1). A self-signed cert cannot be pinned for a WebSocket, so in development the fallback uses `ws://` on
localhost / LAN directly.

**Lanes over one TCP connection.** Every message is framed `u8 lane | u32 length | payload` on the single
socket. All three lanes are reliable and ordered there, so NetSync must not let them queue up:
- **Pulses are never queued.** Before sending a pulse the host checks the socket's buffered bytes; if a pulse
  is still waiting, it skips this tick's pulse (the next one is a delta against the last *acknowledged*
  baseline anyway, so nothing is lost but freshness).
- **Commands:** the peer sends the newest command plus the previous ones not yet acknowledged; no
  redundancy needed on TCP, but the format is the same as on datagrams.
- **Bulk** (join state) is chunked into ≤ 16 KB messages interleaved with control and pulses, so a join does
  not freeze gameplay.
- **Peer-side follow delay** adapts upward when pulses arrive in bursts (TCP retransmission stalls), so
  followed objects stay smooth at the cost of a little more delay.

The rest of NetSync does not know which link it is on: the same messages, encoders and baselines.

## 5. Simulation timing

Today the engine advances by the variable frame delta (`engine.ts` `_tick`; physics cut into ≤ 1/60 s
substeps, `physicsSystem.ts` `substepsFor`). NetSync needs ticks.

- **Host:** `HostRuntime` drives a headless `CleoEngine` (`headless: true`: no renderer, a `NullDevice`, the
  loop detached) with `engine.stepFrame(1/30)` from a deadline-driven `FixedTicker` — physics substepped inside
  the tick, scripts, AI and animators as in a game. Built in phase 2.
- **Peers (moved to phase 5):** a new engine simulation mode, `simulation: 'frame' | 'fixed'` (default `'frame'`, so nothing
  changes for single-player). In `'fixed'` an accumulator runs the control pass, character locomotion and
  physics in whole ticks; rendering interpolates between the last two ticks. Animation, particles, camera
  rigs and UI keep using the frame delta.
- **Clock sync:** the peer estimates host tick from the handshake + periodic pings (RTT / 2 smoothed), runs
  its predicted tick *ahead* of the host by RTT/2 + one tick of jitter margin, and follows other nodes
  *behind* by an interpolation delay (default 2 ticks + jitter). Time dilation and hit-stop are host-driven
  and sent as session state.

## 6. NetSync per engine system

### 6.1 Identity
- Editor-placed nodes keep their uuid. At session start host and peers both load the same scene; the host
  sends a **NetId table** (uuid → NetId) on `control` for synced nodes only.
- Runtime spawns: the host assigns the NetId and root uuid; children get uuids derived from the root
  (`regenerateNodeIds` with a custom `newId`, `src/core/scene/nodeJson.ts:83`) so host and peer agree without
  sending them.
- The handshake compares a **content hash** of the published scenes + templates; a mismatch refuses the join.

### 6.2 Spawn / despawn
- Host: `scene.instantiate(template, {id, …})` on a synced template → `Spawn{netId, template, parent, owner,
  initial fields}` on `control`. Removal → `Despawn{netId}`. Scope changes produce the same messages per peer.
- Peer: applies them with the same `instantiate(…, {id})`.
- Join in progress: full state on a `bulk` stream (built from the save system's capture — `captureScene` /
  `values.ts` encoding — plus the NetId table), then pulses take over.
- Needed engine work: a **live apply** path. Today saves only restore at load (`src/core/save/apply.ts`).

### 6.3 Sync fields
Built-in field sets per node kind (fixed schemas, quantized):

| Node | Fields |
|---|---|
| any synced node | position, rotation, scale (if not uniform 1), visible / dormant |
| body (Collider) | + linear velocity, angular velocity, sleeping |
| CharacterNode | + grounded, crouch, sprint, aimYaw, aimPitch, locomotion state (for owner correction) |
| Animator | gameplay animation state + the parameters not already bound to synced variables (§6.7) |
| node `variables` | opt-in per variable in the inspector |

Script fields:

```ts
import { synced, netcall } from 'cleo/decorators';

class Door extends Node {
    @synced() open = false;                                  // reliable, sent when it changes
    @synced({ every: 'tick', step: 0.01 }) progress = 0;     // in every pulse, quantized to 0.01
    @synced({ to: 'owner' }) ammo = 30;                      // only the owning peer receives it
    @synced({ onChange: 'onOpenChanged' }) locked = false;   // peer runs onOpenChanged(prev) on arrival
}
```

- Recorded as a new `ScriptMember` kind `'synced'` in `src/core/scripting/decorators.ts`; a per-class sync
  schema is built once from the metadata.
- Change detection is by comparison with the last value sent, after each host tick (the engine's
  `SCENE_CHANGED` property events are gated off in play, so they cannot be used).
- Supported types v1: number, boolean, string (≤ 255 B), Vec2/3/4, Quat, node reference (sent as NetId),
  small enums (`@options`). Anything else: use a netcall.

### 6.4 Physics bodies (the heart of a physics sandbox)

#### 6.4.1 Host-simulated props (the default)
- Simulated on the host only. On peers synced bodies become kinematic and are **followed** (interpolation
  buffer with velocity extrapolation for up to ~100 ms when pulses are late — the same idea as the worker's
  pose history, `WorkerExecutor.visualPose`).
- Quantization: position to ~1 mm inside the scene's bounds, rotation as smallest-three (2 + 3×10 bits),
  velocities to the body's speed range. A row for a moving prop is ~12–16 bytes.
- **Sleeping bodies cost nothing**: a body that falls asleep is sent once with `sleeping = 1` and then left
  out of pulses until it wakes. In a sandbox most props sleep most of the time — this is the main bandwidth
  saving.
- **Burst handling** (an explosion wakes 50 props at once): priority packing (§6.6) spreads the burst over a
  few ticks; followed props extrapolate from their last velocity meanwhile, which looks right for
  ballistic motion.
- **Peer's own character vs followed props.** The owner predicts its character, but props on its machine are
  kinematic and slightly in the past, so the predicted capsule could walk through or bounce off a prop the
  host sees elsewhere. v1 rule: the predicted mover treats followed dynamic props as *soft* (it does not block
  on them); the host's physics resolves the real push and the correction is small. Static geometry is always
  solid.
- The physics worker's `{ops, writes}` row layout (`src/physics/pal/copy/copyMessages.ts`) is the reference
  for the row shape, but NetSync has its own encoder: quantized, delta against per-peer baselines, NetIds not
  slots.

#### 6.4.2 Carried props (peer-driven)
Picking up, carrying, rotating and throwing a prop must feel instant, which host-only simulation cannot give
at 100+ ms. While a player carries a prop:
1. The peer sends `Grab{netId}` (control lane). The host grants a **carry** if nobody else holds it, and
   tells everyone `CarryStart{netId, peer}`.
2. The carrying peer drives the prop locally (kinematic, attached to its hold point) and sends its pose in
   every command.
3. The host moves its copy to that pose (as a kinematic body, so it still pushes other props on the host),
   **validates loosely** (within reach of the carrier's host-side position, speed under a cap — co-op trust),
   and sends it to other peers in pulses as usual.
4. `Throw{netId, velocity}` or `Drop{netId}` ends the carry: the host turns the prop dynamic again with that
   velocity and resumes simulating it. The thrower's machine keeps showing the prop where it predicted it,
   blending to the host's pulses over ~200 ms.
5. Carries end automatically on disconnect or after a timeout with no command.

#### 6.4.3 Forces from gameplay
Explosions, impulses, shots hitting props: applied by the host only. The peer that caused it plays the effect
(particles, sound, camera shake) immediately and sees the props react one round trip later — acceptable for
co-op, and far simpler than predicting other bodies' physics.

### 6.5 Characters and input (the feel)
- New `ControlSource` value **`'remote'`** (`src/core/scene/nodes/controllerNode.ts`): the controller fills its
  `ControlIntent` from the peer's `CommandQueue` for the current tick instead of `InputSystem`.
- **Command:** `{tick, move, basisYaw, aimYaw, aimPitch, sprint, crouch, requests}` — the `ControlIntent`
  minus `look` (look is resolved into aim on the peer). Each datagram carries the newest command plus the
  previous 3 for loss cover. The host keeps a small per-peer buffer and repeats the last command on a miss.
- **Predict:** the owner runs its controller + `stepLocomotion` + its pawn's movement every tick and keeps a
  ring of `(tick, command, state)`.
- **Correct:** when a pulse confirms tick *T*, compare with the predicted state for *T*; past a threshold,
  reset to the host's state (including `LocomotionState`: coyote, jumpLockout, smoothDir, turning) and
  re-run the commands after *T*. The visual offset is eased out over ~150 ms.
- **Re-running movement:** the physics world cannot step one body alone. v1 uses a **predicted mover** for
  the owner's pawn: a kinematic capsule sweep (collide-and-slide against static colliders with the existing
  overlap / raycast queries) that matches the character's dynamic behaviour closely enough that corrections
  are rare and small. If that proves too loose, phase 7 adds a client-only predicted physics world holding the
  pawn and static geometry.
#### 6.5.1 Weapons (shooter elements)
- **The shooter's machine does everything visual immediately:** muzzle flash, sound, recoil, tracer, impact
  decal / particles at its own raycast hit. Ammo is predicted (`@synced({ to: 'owner' })` corrects it).
- **Hitscan:** the peer sends `Shot{weaponId, viewTick, origin, direction, claimedHit?}` on the control lane.
  `viewTick` is the tick the shooter was *seeing* followed objects at (its render time). The host:
  1. rewinds hitboxes of AI characters, other players and synced props to `viewTick` (a ring of ~1 s of
     host-side poses, kept for nodes with hitboxes only),
  2. raycasts there, then restores,
  3. applies damage / impulse in the present and sends the result (`Hit{target, …}`) so other peers play
     the impact.
  Trust `coop`: if the host's rewound ray misses but `claimedHit` is within a small tolerance of a valid
  target, the host accepts it (favour the shooter). The tolerance is a project setting. Trust `versus`:
  `claimedHit` is ignored; only the host's rewound raycast counts, and `viewTick` is clamped to the peer's
  measured latency plus the follow delay (so a peer cannot claim an arbitrarily old view).
- **Projectiles** (grenades, rockets): the shooter spawns a **local stand-in** immediately and sends
  `Fire{weaponId, viewTick, origin, velocity, spawnKey}`. The host spawns the real projectile, advanced by the
  shooter's latency so it is not behind, and its `Spawn` carries the same `spawnKey`; the shooter swaps its
  stand-in for the real one, blending the position. Other peers just see the host's projectile.
- Friendly fire is a game rule, decided on the host.

### 6.6 Scope and priority
- Per synced node: `scope: 'all' | 'near' | 'owner' | 'custom'`, with `near` radius; rooms (`onRoomEnter` /
  `onRoomExit`) can be used as scope.
- Each tick, nodes in scope are ranked by `priority × ticks since last sent` and packed until the pulse
  budget (bytes per tick per peer, default ~1.2 KB at 30 Hz ≈ 36 KB/s, i.e. about 70–90 moving rows per
  tick) is full.
- Worst case for the target modes: 16 characters + 50 AI ≈ 66 character rows (~18 B each with aim and
  animation state ≈ 1.2 KB) before any props. That is why priority + scope are required, not optional: an AI
  far behind a wall updates every 3–4 ticks, one shooting at you every tick. Raise the budget to ~1.6 KB if
  playtests show visible stutter on distant hordes; the project setting is per mode.
- Default priorities: own-team / visible player characters > carried props > AI within ~30 m or in view >
  props near the peer that are moving fast > other characters > other moving props > everything else. Far
  away means less often, never never.
- Hordes: AI out of every peer's scope (spawned out of sight) are not sent at all until they come into
  scope — a horde spawn behind a wall costs nothing until it rounds the corner.
- Scope comes into v1 early (phase 3), not as a late optimisation: a sandbox level can hold hundreds of
  props.

### 6.7 Animation
Peers run their own Animators. NetSync sends what *drives* the animation, never the pose.
1. **Locomotion / blend spaces:** driven by synced velocity, grounded, aim. Parameters bound to node variables
   or built-ins (`animator.ts` `_refreshVariableParams`) need nothing extra.
2. **Actions (attacks, emotes, one-shots):** `PlayAction{netId, action, startTick}` on `control`; the
   receiving peer starts it and `seek`s by `(now − startTick)`. The owner plays it immediately when predicted.
   Triggers are sent as events, never as parameter values.
3. **Gameplay states** (stunned, dead, climbing): a synced enum; the peer calls a new public
   `Animator.forceState(name, blend)` (today `_enterState` is private).
4. **Root motion:** moves the character only on the host and in the owner's prediction. Followed characters
   discard it (`consumeRootMotion`) and use the synced position, which avoids double movement and foot slide.
5. **Animation events** (footsteps, sound, particles) fire locally on every peer from its own Animator.
   Gameplay results (damage) come only from the host.

### 6.8 Behaviors and AI
Host only: perception, think, behaviour machines, goals, steering, pathfinding. They all end in a
`ControlIntent`, so an AI character on a peer is followed exactly like a remote player. Peers set
`controlSource: 'none'` on host-driven controllers. Visible AI state (alert, mood) is a `@synced` field.

### 6.9 Scripts
- **`this.net`** on every node: `isHost`, `isPeer`, `isOwner`, `owner`, `netId`, `synced`.
  Guard gameplay: `onTrigger(other) { if (!this.net.isHost) return; … }`.
- **`@netcall`**:
  ```ts
  @netcall({ to: 'host' })                 requestOpen() { … }     // a peer asks; runs on the host
  @netcall({ to: 'all', reliable: false }) flash(color: Vec3) { … } // host tells every peer in scope
  @netcall({ to: 'owner' })                 showHint(text: string) { … }
  ```
  The decorator returns a wrapper (method decorators may, `decorators.ts:427`) that encodes arguments with the
  save system's value encoding (typed arrays, node references), checks who may call it, and sends it. A
  `to: 'host'` call from a peer checks that the peer owns the node unless `{anyone: true}`.
- **`Net.emit(name, payload, {to})`** arriving as an ordinary `@onEvent` on the other side — the existing
  `GameEvents` style for authors who prefer events.
- Timers (`after`, `every`) run where the script runs; on peers use them for visuals only.
- Randomness: a tick-seeded `Game.random` (from `seededRandom`, `src/core/math.ts:437`); gameplay rolls happen
  on the host.

### 6.10 Effects, audio, sequences
- Particles and sounds: local, triggered by synced state, `PlayAction` or netcalls. Seeded by node id already.
- Sequencer: `PlaySequence{id, startTick}`; continuous tracks are seekable; gameplay event keys fire only on
  the host.

### 6.11 2D
`World2D` / `locomotion2d` are pure TypeScript with small fixed substeps: the predicted mover is the real
2D step, so 2D games get exact re-simulation for the owner's pawn from day one.

## 7. Host runtime (headless)

`HostRuntime` (`src/netsync/host/`) runs a published game's scenes in Node:
- Builds `Scene` + `PhysicsSystem` + `AISystem` directly (as `tests/sandboxProject.test.ts` already does), no
  `CleoEngine`, no renderer.
- Model nodes load skeletons, animation clips and collision only — no GPU buffers (a `headless` flag on the
  model / asset loaders).
- Audio and UI become no-ops (Howler needs `window`).
- `Scene.update` takes an input source instead of reading `InputSystem.instance` directly (`scene.ts:786`);
  on the host it is an empty source.
- `CleoEngine.instance` statics used by the `Game` facade get a host implementation.
- Packaged as `applications/host` (a Node CLI: `cleo-host --project <published game> --port 443`), shipped
  as a container image as well. Hosts are always dedicated: the desktop app never runs one, except the
  editor launching a local `cleo-host` process for testing (§8).
- One host process runs one session (one scene set, up to 16 peers + 50 AI). Scale out by running more
  processes; a thin **allocator** service hands peers a host address (§7.1).
- **CPU budget:** one tick of physics + AI (perception, think, pathfinding for 50 agents) + encoding pulses
  for 16 peers must fit in ~25 ms of one core at 30 Hz. Node runs the host on one thread; Jolt is WASM
  single-threaded. Phase 2 measures this on the sandbox example with 50 AI and sets the "sessions per vCPU"
  number hosting costs are based on. Expected: about one vCPU per busy session.

### 7.1 Where dedicated hosts run

What a NetSync host needs from a hosting option:
- **UDP** for WebTransport (QUIC), on any port, IPv4 at least.
- **TCP 443** for the WebSocket fallback — the fallback exists for networks that block UDP, and those
  networks usually block unusual TCP ports too, so the fallback must be reachable on 443.
- **TLS:** WebTransport can use a self-signed certificate pinned by hash (no domain needed), but a WebSocket
  (`wss://`) needs a real CA certificate, i.e. a domain name per host or a shared entry point.
- **Bandwidth:** a full 16-peer session sends ~0.6 MB/s ≈ 2 GB per session-hour (8 peers ≈ 1 GB). Egress
  price matters more than CPU price for this game.
- **Lifecycle:** start a session on demand, close it when the match ends.

The options:

| Option | Examples | Pros | Cons |
|---|---|---|---|
| **A. Self-managed VPS / bare metal** | Hetzner, OVH, Vultr, DigitalOcean, any VPS | Cheapest per session; generous or unmetered traffic on many providers (egress mostly free); full control of UDP and TCP 443; simple to reason about; run many sessions per box. | You build the allocator and health checks; fixed capacity (pay when idle, can run out at peaks); you pick regions by hand; you patch the machines. Prices are not fixed — Hetzner raised cloud prices sharply twice in 2026. |
| **B. Managed game-server hosting** | Edgegap, Amazon GameLift Servers (managed containers), Gameye, Nitrado GameFabric | Starts a container per match on demand near the players, scales to zero, global regions, allocation API built in, made for UDP game traffic. | Pay per vCPU-minute **plus egress** (Edgegap ≈ $0.069 / vCPU-hour and $0.10 / GB → about $0.10–0.20 of traffic per session-hour at our rates); hosts usually get an IP and a random port, which is fine for WebTransport but breaks "fallback on TCP 443" unless traffic goes through your own entry point (below); vendor risk — Hathora shut down game hosting in May 2026 and Unity ended Multiplay in March 2026. |
| **C. Kubernetes + Agones** (self-run) | Agones on GKE, EKS, AKS, or on VPS nodes | Open source, portable between clouds, autoscaling fleets and allocation done for you; no per-minute vendor fee. | You run Kubernetes — a lot of operations for a small team; still need the TCP 443 entry point; cloud egress is expensive on the big three. |
| **D. General app platforms** | Fly.io, Railway, Render, Cloud Run, Azure Container Apps | Easy deploys. | Mostly HTTP / WebSocket only. Fly.io supports UDP but its docs say QUIC / HTTP/3 is not supported. Using these means WebSocket only — defeats the plan. **Not recommended.** |
| **E. Edge serverless** | Cloudflare Workers / Durable Objects | Great for lobbies, chat, turn-based games. | WebSocket only, CPU-time limits; cannot run a 30 Hz physics + 50-AI simulation. **Not suitable for the host**; fine for a lobby service. |

**The certificate / port problem and the fix: an entry point you own.** All options except A-with-one-box
need a way to put the WebSocket fallback on TCP 443 with a real certificate. Plan for a small **gateway**:
- one domain (`play.yourgame.com`) with a real certificate on TCP 443 per region;
- peers open `wss://play.yourgame.com/s/<sessionId>`; the gateway forwards the bytes to the session's host
  (any IP / port, plain TCP inside the provider's network);
- WebTransport goes **directly** to the host's IP and UDP port with a pinned certificate hash handed out by
  the allocator (`serverCertificateHashes`) — no domain needed per host, and the gateway never carries UDP.
The allocator and gateway can be one small Node service (or HAProxy / Caddy with a routing map). It is also
the only piece that must stay up between matches.

**Who chooses.** Cleo does not pick a provider: the **game developer** chooses where their hosts run.
Cleo's job is to make every option above (A–C) a deployment choice rather than a code change — §7.2.
Guidance the docs give developers: start on A (one VPS, cheapest, simplest); move to B when you need
on-demand capacity in many regions; C only with a team that already runs Kubernetes; never D or E for the
host. Check live price pages before choosing B (sources disagree on GameLift's billing unit and egress).

### 7.2 Cloud-agnostic hosting: one host contract, swappable adapters

The approach is **ports and adapters**: everything Cleo ships runs on any provider, and the few
provider-specific calls live in small adapters the developer selects in configuration.

**What Cleo ships (all provider-neutral):**

| Piece | Form | Job |
|---|---|---|
| **Host** (`cleo-host`) | OCI container image (linux/amd64 + linux/arm64) **and** a plain Node bundle for machines without containers | Runs one session (§7). |
| **Allocator** (`cleo-allocator`) | container image / Node bundle | Hands a joining player a host: address, UDP port, cert hash, gateway URL, join token. Starts / finds hosts through a **fleet adapter**. |
| **Gateway** (`cleo-gateway`) | container image / Node bundle | TLS on TCP 443, forwards `wss://…/s/<session>` to the host's TCP port (the fallback, §4.6). |
| **Deploy templates** | files in the published host bundle | `docker-compose.yml` (single VPS), a Helm chart with an Agones `Fleet` (Kubernetes), an Edgegap app definition, a systemd unit (VPS without Docker). |

**The host contract** — the only things a provider must give the host, and the only things the host gives
back. Any platform that can run a container (or a Node process) with these can run Cleo hosts.

- **In (environment variables / flags):** `NETSYNC_UDP_PORT`, `NETSYNC_TCP_PORT`, `NETSYNC_CONTROL_PORT`,
  `NETSYNC_PUBLIC_ADDRESS` (or discovered by the lifecycle adapter), `NETSYNC_SESSION` (scene, mode, max
  peers — or set later by allocation), `NETSYNC_TOKEN_KEY` (public key for verifying join tokens),
  `NETSYNC_LIFECYCLE` (`none` | `agones` | `edgegap` | `gamelift` …).
- **Out (control port, HTTP):** `GET /healthz` (process alive), `GET /readyz` (content loaded, accepting
  peers), `GET /status` (peers, AI count, tick time, bytes/s — for autoscaling and dashboards),
  `GET /cert-hash`, `POST /allocate` (assign a session to a warm host; used by pool-style fleets).
- **Lifecycle:** `SIGTERM` = drain (refuse new peers, end the match, exit within a grace period). The host
  exits when its session ends unless started with `--reuse`, so "one container per match" and "warm pool of
  processes" both work.
- **Stateless:** nothing on local disk; logs to stdout as JSON lines; metrics on `/status` (optional
  Prometheus format).
- **Join tokens:** the allocator signs a short-lived token (session, peer slot, expiry); the host checks it
  with the public key. Host and allocator never need to call each other, so they can live on different
  providers.

**Two adapter seams — the only provider-specific code:**

1. **Lifecycle adapter (inside the host).** For platforms that need the game server itself to report
   state. `none` (default: HTTP endpoints are enough — VPS, Docker, Edgegap), `agones` (Agones SDK sidecar:
   Ready / Allocated / Shutdown / health), `gamelift` (process-ready / session-activated calls; GameLift's
   server SDK is not offered for Node as far as checked, so this adapter may call it through a small
   sidecar — verify in phase 9). An adapter is ~100 lines behind:
   ```ts
   interface HostLifecycle {
       start(host: HostInfo): Promise<void>;        // tell the platform we're up (ports, address)
       ready(): Promise<void>;                      // content loaded, accept a session
       onAllocate(cb: (s: SessionSpec) => void): void;
       sessionEnded(): Promise<void>;               // platform may recycle or stop us
       onShutdown(cb: () => void): void;            // platform asks us to drain
   }
   ```
2. **Fleet adapter (inside the allocator).** How to get a host for a new match: `static` (a list of host
   processes on machines you run — VPS), `docker` (start a container on a Docker host you own), `agones`
   (GameServerAllocation API), `edgegap` (deploy API, per match), `gamelift` (create game session),
   `custom` (the developer's own HTTP endpoint).
   ```ts
   interface FleetAdapter {
       acquire(req: { region?: string; mode: string; maxPeers: number }): Promise<HostEndpoint>;
       release(host: HostEndpoint): Promise<void>;
       list(): Promise<HostStatus[]>;              // for dashboards / autoscaling
   }
   ```

**What the developer does:** publish the host bundle from the editor → pick a deploy template (or none) →
set `fleet` and `lifecycle` in `netsync.hosting.json` → deploy with that provider's own tools. Moving to
another provider = new template + adapter names, same image, same game build.

**What stays out of Cleo:** accounts, matchmaking rules, payments, region selection logic beyond "nearest
by ping", provider credentials. The allocator exposes hooks (`onRequest`, `chooseRegion`) for the
developer's own backend instead.

**Native addon caveat.** The WebTransport host library is a native Node addon. The container image pins
the Node version and ships prebuilt binaries for amd64 and arm64; the plain Node bundle documents the
supported OS / Node versions. This is the main reason the container image is the recommended form.

## 8. Editor

- **Node inspector › NetSync section:** synced on/off, owner rule (host / spawning peer), scope, priority,
  per-variable sync, the script's `@synced` fields listed read-only. Clear "nothing synced" state (Godot's
  most common pitfall is properties silently not syncing).
- **Project › NetSync settings:** tick rate, interpolation delay, pulse budget, max peers, host port.
- **Play › Multiplayer:** start a local `cleo-host` with the current scene and open N peer windows (or panes)
  with self-signed cert hashes wired in automatically; per-peer `ConditionedLink` sliders (latency, jitter,
  loss) and a "force WebSocket" toggle per peer, so the fallback gets played as much as the main path.
- **NetSync debugger panel:** bytes / tick per peer, pulse loss, corrections per second, NetId table, a node's
  last pulses.
- **Publishing:** "Publish host" alongside the player build (the Node host + the game's content).

## 9. Testing

- All of Sync runs over `LoopbackLink` + `ConditionedLink` in vitest (Node), with a host `Scene` and N peer
  `Scene`s in one process — no browser needed. Golden tests: spawn / despawn / join-in-progress, pulse delta
  encoding round-trips, prediction with 150 ms / 5 % loss converges, netcall permission rules.
- Encoders: property tests (random values → encode → decode within quantization step).
- WebTransport: a Node integration test (host library + Node client from the same package) plus a
  `playerSmoke`-style browser test against a local host.

## 10. Phases

| # | Phase | Delivers | Exit criteria |
|---|---|---|---|
| 0 | **Spike** | Node host (fails-components + `ws`) + browser page exchanging datagrams, a stream, and the WebSocket fallback, with hashed certs | §4.5 checklist answered for every target browser; fallback connects when UDP is blocked |
| 1 | **Link + Session** | `NetLink`, `WebTransportLink`, `WebSocketLink`, `connect()` fallback choice, `HostListener`, `LoopbackLink`, `ConditionedLink`; handshake, version + content hash, PeerIds, clock sync, ping | peers connect over either link, agree on host tick within one tick, reconnect works |
| 2 | **Headless host** | headless `CleoEngine` + `NullDevice`; `HostRuntime` loading game.bin through the player's own loader; `cleo-host --game / --example` | sandbox example runs on the host at 30 Hz; single-player unchanged (existing tests green) |
| 3 | **Identity, spawn, pulses, scope** | NetId table, spawn / despawn, built-in field sets, quantized delta pulses with acks, sleep skipping, priority packing + scope, follow buffer, join in progress (live apply), pulse skipping on WebSocket | 16 peers + 50 AI see the same 200-prop sandbox (explosion included) within budget, at 150 ms / 5 % loss, on both links; host tick under 25 ms |
| 4 | **Commands + remote control** | `CommandWriter` / `CommandReader`, `controlSource: 'remote'`, per-controller input source (instead of the `InputSystem` singleton) | each peer drives its own character (no prediction yet) |
| 5 | **Predict / correct** | engine `simulation: 'fixed'` on peers (tick accumulator, render interpolation); predicted mover (soft props, solid statics), command ring, correction + smoothing | own character feels local at 150 ms; corrections rare on flat ground and among props |
| 6 | **Carry + weapons** | grab / carry / throw / drop, hitbox history and rewind, `Shot` / `Hit`, projectiles with local stand-ins | carrying and throwing feel local; hitscan registers at 150 ms against moving AI and players; grenades land where the host says without visible pops; `versus` trust rejects forged shot claims |
| 7 | **Script surface** | `@synced`, `@netcall`, `this.net`, `Net.emit`, `Game.random`, decorator completion in the script editor | a door / pickup / scoreboard / weapon example works from scripts alone |
| 8 | **Animation + effects** | `PlayAction`, `Animator.forceState`, root motion rules, `PlaySequence` | fire / reload / hit reactions line up on all peers; no foot slide on followed characters |
| 9 | **Editor + publishing + hosting** | inspector section, Play › Multiplayer (with force-WebSocket), debugger panel, Publish host (container image + Node bundle + deploy templates), allocator + gateway, host contract, lifecycle adapters `none` / `agones`, fleet adapters `static` / `docker` / `agones` / `edgegap`, deployment guides per option (`gamelift` adapters after a verified spike) | a new user can build the co-op example and a bot-filled 8v8 deathmatch from docs alone and play them on a VPS host |

Phases 0–3 are the foundation; 4–6 make the target game playable; 7–9 make it usable by game authors.

### Progress

| Phase | State | Where |
|---|---|---|
| 0 | Done except Safari on a real Apple device, a real network, Linux arm64 | [tools/netsyncSpike](../../tools/netsyncSpike/README.md) |
| 1 | **Done (2026-11-19).** Peers connect over either link (and fall back), are seated, agree with the host on the tick within one tick (tested at 100 ms RTT with jitter and 10 % loss), and take their seat back after a drop. Verified in Node over real sockets and in Chrome, Edge and Firefox against `cleo-host`. | `src/netsync/` (links, sessions, clock, ticker), `applications/host` (see its README) (listeners, CLI), tests `tests/netsync*.test.ts`, `applications/host/tests` |

| 2 | **Done (2026-11-19).** The Sandbox and Firing Line examples run headless on the host from a game.bin — models, shared clips, scripts and script modules (inline or extracted to game.scripts.js), physics on Jolt — at 30 Hz. `cleo-host --example …/firing-line` plays the bot match in real time. | `src/core/engine.ts` (`headless`), `src/graphics/rhi/null/nullDevice.ts`, `applications/editor/src/player/gameContent.ts` (the player's loader, now shared), `applications/host/src/hostRuntime.ts`, `exampleGame.ts`, `applications/host/tests/hostRuntime.test.ts` |

| 3 | **Done (2026-11-19), except the 50-AI part of the exit criterion** (see phase-2 findings). Peers get the table of synced nodes, every template copy spawned on the host (with the host's node ids, so later messages and saves name the same nodes), every removal, and per-tick state; a peer that joins late or resumes gets the same baseline. Measured on the Sandbox over loopback at 150 ms RTT, jitter and 5 % loss: 200 props and an explosion, 16 peers (and a TCP-like link for the WebSocket fallback) — every peer within 1200 B/tick, props at rest cost 0 B/tick, everyone converges within 2 mm, a prop in flight is drawn within 2.6 cm (p50) of where the host had it; the host's sync work for 16 peers is 0.7 ms a tick (p95 1.3 ms). | `src/netsync/sync/` (`quantize.ts`, `syncMessages.ts`, `syncHost.ts`, `syncPeer.ts`), `tests/netsyncQuantize.test.ts`, `applications/host/tests/sync.test.ts`; `cleo-host` runs `SyncHost` on its game |

| 4 | **Done (2026-11-19).** Each joining peer is given a character (the game decides how: `possess(peer)`; `cleo-host --player-template Player`) and drives it with commands; the host simulates it, every peer sees it. At 150 ms RTT and 5 % loss two peers moved their characters ~9 m each in 2 s in the directions they asked, a single jump press jumped once, and a silent player's character stops. Over real sockets in real time (WebTransport and WebSocket peers against `HostListener`): 8.5 m in 2 s each, ~30 commands/s. | `ControllerNode` `controlSource: 'remote'` + `remoteIntent` + `publishedIntent`; `src/netsync/sync/commands.ts` (`RemoteControl`, `CommandQueue`, `PeerCommands`); `HostSession.route` / `PeerSession.route`; `SyncHost` `focusOf`; tests `tests/netsyncCommands.test.ts`, `applications/host/tests/control.test.ts`, `realSockets.test.ts` |

| 5 | **Done (2026-11-19) for the prediction itself; the browser-side peer loop is open** (see below). A peer simulates its own character ahead of the host and corrects to it. At 150 ms RTT and 5 % loss on the Sandbox: the character moves on its player's screen 2 frames after the input (its own acceleration) and on the host 6 frames after — the round trip no longer shows. Walking, strafing, sprinting, jumping and stopping on open ground: 155 host states compared, **0 corrections**, worst error 0.1 cm. Running into a wall of crates (followers on the peer, solid on the host): 16 of 79 states corrected, worst 6.8 cm, no snaps, ending 1.8 cm from the host. | `src/netsync/sync/predictor.ts`; `SyncPeer` `simulated` / `isOwn` / `onOwnState` / `followerSceneJson`; `PeerCommands.send`; `buildGameScene` `prepare`; `applications/host/tests/predict.test.ts` |

| 6 | **Done (2026-11-19).** Sandbox, 150 ms RTT, 5 % loss. Carrying: the prop sits where it is held on the carrier's screen at once, within 15 cm of that on the host, stays within reach while walking, cannot be taken by another player; a throw flies 9.8 m on the host and the thrower's screen never moves it more than 31 cm in a frame (its flight speed) across the hand-over. Hitscan at a player running across the line of fire: 5 of 5 hit, all 5 only thanks to the rewind. Trust: co-op accepts a claimed near miss and clamps an old view; versus refuses both; a forged claim is refused under both. Projectile: the stand-in leaves at once, swaps for the host's with no jump (26 cm largest step at ~21 cm/frame) and lands within 1 mm of the host's. | `src/netsync/sync/carry.ts` (`CarryHost`, `CarryPeer`), `weapons.ts` (`LagCompensator`, `WeaponHost`, `WeaponPeer`); `SyncPeer` `hold` / `release` (blended) / `renderTick`; `SyncHost` `nodeOf` / `synced`; `cleo-host --trust`; `applications/host/tests/play.test.ts` |

| 7 | **Done (2026-11-19).** Four game scripts, written with nothing but the new surface, run on a host and two peers at 150 ms RTT and 5 % loss: a door any player opens (`@netcall({ to: 'host', anyone: true })`, `@synced({ onChange })`), a gun only its owner fires (`'host'`) whose shot flashes everywhere (`'all'`, unreliable) and whose hint reaches its owner alone (`'owner'`), a pickup the host scores and removes, and a scoreboard with a synced object and a synced node reference. `this.net` answers host / peer / offline and ownership correctly; a player's event reaches the host and the other players; a late joiner gets every synced field. | `src/core/net/sceneNet.ts` (`SceneNet`, `NodeNet`), `scene.net`, `node.net`, `@synced` / `@netcall` in `cleo/decorators`, `Game.random` / `seedRandom`, `Net`; `src/netsync/sync/scriptSync.ts` (`ScriptHost`, `ScriptPeer`); `RemoteControl.ownerOf`; editor `@` completion; tests `tests/netsyncScripting.test.ts`, `applications/host/tests/scripts.test.ts` |

| 8 | **Done (2026-11-19).** A followed player's character, watched by another player at 150 ms RTT and 5 % loss while it runs, sprints, strafes and stops: its animator is in the host's state on 100 % of frames, its speed parameter is the host's to 0.015 m/s on average, and the animation's speed matches the character's motion to 0.14 m/s (no foot slide); an action the host plays shows on the watcher while it draws that very tick (225 → 225.4); a state forced away comes back. 27 B/tick of parameters. The 50-AI host budget: Firing Line with 50 fighters ~22 ms a tick mean (was ~26), p95 ~37 (was 45–67). | `src/netsync/sync/animSync.ts` (`AnimHost`, `AnimPeer`); `Animator.forceState`; `SyncPeer.renderTick` measured from the newest state that can have arrived; `Scene.aiDetail` + `Scene.takePathSearch`; `HostRuntime` AI detail and animation LOD (`focusPoints`); tests `applications/host/tests/anim.test.ts`, `hostRuntime.test.ts` |

Phase-8 details and findings:
- **Animation is driven, not sent.** `AnimHost` sends each followed character's animator parameters when they
  change (a full set every 30 ticks for loss), plus triggers, actions and base-layer state changes reliably,
  stamped with the tick. `AnimPeer` pins the parameters (`setParamOverride`, which wins over a parameter's
  link to the local character — on a peer, a follower whose senses read nothing true) and fires events when
  it draws their tick. Numeric parameters are blended across the tick a change happened in, as positions are;
  a gap between samples means "unchanged" (blending across the whole gap made it worse). A state that differs
  from the host's for 15 ticks is forced. Animators are addressed by character NetId and order among its
  animated models.
- **Follow point fixed (all of sync):** `renderTick` was "the host clock now, minus 2 ticks", but a pulse
  takes half a round trip to arrive, so at 75 ms one way the tick drawn had often not arrived and followed
  nodes were extrapolated. It is now measured back from the newest state that can have arrived (host clock −
  RTT/2 − jitter − 2 ticks). Found because animation parameters cannot be extrapolated; it also took the
  200-prop follow error in flight from 2.6 cm / 23 cm (p50 / p95) to 0.7 cm / 2.1 cm. Shots are judged at
  this same view.
- **Host AI detail** (`Scene.aiDetail`, default every frame; `HostRuntime` sets perceive every 3 ticks,
  obstacle whiskers every 2, at most 1 path search a tick): each agent takes its turn on its own frame of the
  cycle with the time since its last. At 50 fighters perception 9.1 → ~3.5 ms, path searches 2.9 → 1 per
  tick. **Host animation LOD**: animators posed as an off-screen model would be, by distance to the nearest
  player (every 2nd tick within 15 m, every 4th beyond), foot IK off: 9.5 → ~3.5 ms.
- **Still open:** a navmesh path search costs ~4 ms on Firing Line's mesh, the largest single item left in a
  50-fighter tick (p95 ~37 ms); speeding up the search itself is engine work outside NetSync.

Phase-7 details and findings:
- **`this.net`** reads the scene's network (`scene.net`, set by `ScriptHost` / `ScriptPeer`). Offline a game is
  its own host: `isHost` is true and `online` false, so code guarded with `if (!this.net.isHost) return` keeps
  working single-player. `owner` is the peer whose character's tree (the top-level node its controller sits
  in) holds the node, 0 for the host's; a peer only knows its own tree, so it reads other players' nodes as
  the host's — enough for `isOwner`.
- **`@synced`** fields are compared each tick on the host (as JSON) and sent reliably when they change; a
  joining peer gets them all after the sync baseline. `onChange` runs only when the value actually changes
  (the baseline repeated the scene's own values and ran it once too often — found by the door test). Node
  references travel by id; typed arrays as arrays.
- **`@netcall`** wraps the method; the wrapper asks `scene.net` and the network runs the ORIGINAL when the call
  arrives, so a call is never routed twice. The host checks a peer's `'host'` call: the node's script must
  declare it, and the peer must own the node unless `anyone`. `this.net.caller` names the peer during the call.
  Peers cannot call `'all'` or `'owner'` (only the host tells others).
- **Synced nodes** now include any node whose script declares `@synced` or `@netcall`: they need a NetId.
- **Per-player input for scripts** is answered by `@netcall`, not by a per-player `Input`: the owner's script
  reads its own input and calls a `'host'` netcall (the gun above). Scripts on the host reading `Input` still
  see nothing for remote players, by design.
- **Bug fixed:** "top-level node" (for ownership) meant the child of the scene's root, not a node with no
  grandparent — the scene's content root has a parent, so every player's tree looked like one. The host's
  `RemoteControl.ownerOf` had the same mistake and only passed the first test by peer order.
- **Not yet:** user documentation (phase 9); the editor shows no network badges on synced fields.

Phase-6 details and findings:
- **Carrying** moves the host's copy by velocity toward the carrier's pose (minus the gravity the step will
  add), so it still pushes what it meets; the pose is clamped to reach (2.5 m × 1.5 under co-op, × 1 under
  versus) and throws to 25 m/s. A carry ends on throw, drop, leave or 15 silent ticks. After a throw the
  thrower flies the prop on a plain ballistic arc (it touches nothing) for a round trip plus the follow delay,
  then blends to the host's states over 200 ms. Poses are in the prop's parent space: loose props at the scene
  root, as in the Sandbox.
- **Hitscan** is judged at the shooter's view: the fractional host tick it was drawing (`SyncPeer.renderTick`).
  `LagCompensator` keeps one second of every synced body's pose, moves them all back for the raycast and puts
  them back. A co-op claim is accepted when the ray passes within 0.6 m of the bounding sphere of the claimed
  body's colliders — generous for a thin capsule, by design (favour the shooter). Hitboxes are the collider
  bodies, not per-bone shapes.
- **Projectiles** are spawned on the host already advanced by the time the fire message took
  (`currentTick − viewTick`, ballistically), and named back to the shooter by a key it chose.
- **Bug fixed (sync, phase 3):** a spawn travels on the reliable lane and its first states on the unreliable
  one, which can overtake it. The peer dropped rows for NetIds it did not know yet but still acknowledged the
  datagram, so for a body at rest the host never sent that state again (a projectile's shooter, or a prop
  spawned at rest, stayed at the template's origin). `SyncPeer` now keeps early rows and applies them when the
  spawn lands.
- **Bug fixed (prediction):** a body the predictor moves is woken, or physics never writes its pose to the
  node (a character that settled where it spawned was drawn at the template's origin).
- **Not yet:** game rules on a hit (damage, friendly fire) are the game's, through `onHit`; scripts that fire
  weapons from `Input` on the host see nothing for a remote player until phase 7.

Phase-5 details and findings:
- **Correction by offset, not re-simulation.** The engine cannot step one body alone, and stepping the peer's
  whole world again for every correction is the expensive path the plan feared. The predictor keeps each
  predicted tick's position and velocity; when the host's state for tick H differs, the velocity is corrected
  at once and the position blended in (30 % of what is left per tick, snapped past 1.5 m), and every
  prediction after H is shifted by the same error so it is corrected once. On the same engine, physics backend
  and tick, prediction on open ground matched the host to the millimetre, so corrections only come from what
  the two sides see differently.
- **Followers on a simulating peer.** `followerSceneJson` (authored scene, before parse) and `SyncPeer`
  `simulated` (spawned copies) make every body the host simulates a static collider without collision response,
  moved by sync, and switch off controllers the peer does not drive. Only the peer's own character stays
  dynamic. Hence the corrections among props: the host's crates stop the character, the peer's do not.
- **Bug fixed in spawned copies (phase 3):** a peer renamed a copy's nodes to the host's ids but left the copy's
  internal references (a controller's character, a camera's target) on the throwaway ids instantiate made, so
  a spawned controller drove nothing on a peer. References are now remapped with the ids.
- **The first host state places the character** (a copy spawns at its template's origin; prediction starts
  from where the host has it).
- **Ordering:** the peer must learn which character is its own before that character's spawn is applied
  (`SyncPeer` takes `isOwn` at construction; `PeerCommands` is created first). `RemoteControl` sends the
  Possess before the spawn reaches the peer. An authored (not spawned) character is made a follower at parse
  and cannot be predicted yet.
- **Open:** the browser-side peer loop — a non-headless engine stepping its simulation in host-numbered
  ticks (`Predictor.dueTick()`) with render interpolation between ticks, and the local controller reading
  real input (`controlSource: 'player'`). The tests drive the same steps by hand; the loop lands with the
  editor's Play › Multiplayer (phase 9). Until then followed characters and props are drawn at 30 Hz.
- Not done: other players' characters still do not animate (phase 8); the peer's own rotation is predicted
  and never corrected (only position and velocity are).

Phase-4 details and findings:
- **A command** is the intent a peer's controller published that frame (`ControllerNode.publishedIntent`):
  move, move basis, aim yaw and pitch, sprint, crouch, speed scale and each raised request's buffer — 21 bytes,
  four per datagram (the newest and the three before). Look deltas are not sent: a peer turns its own camera,
  and its aim is what reaches the host. Stamped with the host tick due when it arrives (half the RTT ahead,
  plus one tick).
- **The host's queue** applies each tick's command; a missing one repeats the last movement for up to 6
  ticks, then the character stops. A request is applied exactly once, even when its command arrives after
  its tick was played (its datagram lost, a later one carrying it): found by a unit test, and the queue had
  to zero requests itself because `clearIntent` keeps them on purpose.
- **The host's camera rig follows the remote aim**, so host-side logic that reads the rig sees where that
  player looks.
- **Distance priority:** `SyncHost` weighs each row by the distance from the peer's own character
  (`focusOf`, halving at 20 m) — what is near you is updated first.
- **Message routing:** sessions route app messages by type (`route(lane, types, handler)`), so sync,
  commands and the layers to come share a session; held control messages replay in arrival order.
- **Not yet:** prediction — a player's own character answers after the round trip plus the follow delay
  (phase 5); scripts on the host that read `Input` (the Firing Line player's fire button) see nothing for a
  remote player — per-peer input for scripts is phase 7; the editor's Control Source dropdown now lists
  "Remote", which only the host should set.

Phase-3 details and findings:
- **Rows are absolute, not bit-deltas.** Each row is a node's full quantized state (≈24 bytes with a velocity),
  and a node is sent only when it differs from what that peer has acknowledged. Every datagram stands alone,
  so loss costs freshness, never correctness. Bit-level delta compression against a baseline (Fiedler) is the
  next step if bandwidth gets tight; with 200 props in the air the 1200 B budget updates each about every
  4 ticks, which is where the 23 cm p95 follow error during an explosion comes from.
- **Acknowledgement is per datagram**, not per tick: a tick's rows can span two datagrams, and acknowledging
  the tick when only one arrived marked the other's rows delivered (found by the 200-prop test).
- **Synced nodes (v1):** dynamic colliders, characters, and anything with a truthy `netSync` variable;
  transforms are LOCAL. Kinematic movers (doors, platforms) need `netSync` until phase 7's inspector.
- **Rotation error** of the 32-bit smallest-three quaternion is up to 0.23°, not the 0.1° first assumed.
- **Peers only follow.** A peer that also ran the game's scripts would spawn things of its own (the Firing
  Line manager fills the match with bots on every machine). Until phase 7's `this.net.isHost`, a peer's scene
  must not run gameplay scripts; the tests use a parsed, unstarted scene.
- **Not yet:** priority by distance and scope (no peer owns a character until phase 4), animation state
  (phase 8: followed characters do not animate), the simulation range measured from peers.
- `PeerSession` now holds app control and bulk messages that arrive before a handler is attached (the host
  sends its baseline right after the Welcome).

Phase-2 findings:
- **CPU budget is not met at 50 AI yet.** Firing Line on the development machine: 12 fighters ~4–5 ms per
  tick; 50 fighters ~26 ms mean, p95 36–67 ms — over the 25 ms budget. At 50, AI perception (~7 ms) and
  think (~7 ms) and the animators (~7 ms) dominate; physics is ~1.4 ms. Planned fixes, before phase 8's
  50-AI exit criterion: stagger perception and think across ticks (each agent every 2nd–3rd tick), a host
  animation LOD (bots far from every player pose at a lower rate; only root motion and hitboxes need the pose
  on the host), and profiling the bot scripts.
- **Physics simulation range is camera-relative.** The host turns the global range off, but a body's own
  `simulationRange` still measures from the scene's active camera. Phase 3 measures it from the nearest
  peer's character instead.
- **Content hash** is carried in the pack: `packGameBin` writes `manifest.contentHash`, a 64-bit fingerprint
  of the manifest and every chunk's bytes, so a browser peer reads it from the header instead of hashing the
  file. The manifest alone is not enough (its chunk refs are offsets and lengths, blind to a same-size edit).
  `cleo-host` uses it, and hashes the whole file (SHA-256) only for packs made before it existed.
- **The client fixed-tick mode moved to phase 5**, where prediction is its first user; building it now would
  mean guessing its requirements. The scene input-source change moved to phase 4 for the same reason.
- Script modules are reset per game (`resetScriptModules`): a host process that ran one game must not leak
  module state into the next.

Phase-1 details worth knowing for later phases:
- The link API is `sendControl` / `sendPulse` (returns false when not sent) / `sendBulk`. Bulk messages are
  delivered whole but are **not ordered** relative to control or to each other.
- Message types below 32 on the control and pulse lanes belong to the session (hello, welcome, refuse, bye,
  ping, pong); 32 and up are passed to the layer above (`FIRST_APP_TYPE`).
- Sending while a peer is reconnecting returns false and is **not queued**; phase 3 resyncs a resumed peer from
  a fresh baseline instead.
- `FixedTicker` is the deadline-driven tick loop phase 2 builds the host runtime on.

## 11. Decisions and their reasons

- **Server-authoritative + predict / follow**, not lockstep / rollback: variable timestep today, no physics
  save / restore, WASM physics in f32 with no cross-machine determinism guarantee, and unseeded `Math.random`
  in scripts. These rule out input-only sync for 3D. (2D could support rollback later — §6.11.)
- **WebTransport first, WebSocket fallback in v1**, both behind `NetLink`; a sidecar QUIC server stays a
  drop-in option if the Node library disappoints.
- **Dedicated hosts only**: no host migration, no trust in a player's machine as host, one deployment shape.
- **Co-op trust level**: carried props and shot claims are validated loosely, not re-simulated; tightening
  this later is a host-side change only.
- **30 Hz host tick** for the target game: physics is substepped inside it, hitscan is lag-compensated, so
  60 Hz would double bandwidth for little visible gain. Configurable per project.
- **NetSync has its own encoder**, rather than reusing the physics worker's codec: the worker sends lossless
  f64 rows keyed by reusable slots, with no baselines or acks — the right choice for threads, the wrong one
  for a network.
- **Opt-in syncing**, never "everything": bandwidth is the budget that matters.

## 12. Questions

**Answered (2026-11-19)**
- Target game: co-op physics sandbox with shooter elements → §2, §6.4, §6.5.1, §6.6, phase 6.
- Hosts: dedicated only → §7, §11.
- WebSocket fallback: yes, in v1 → §4.6, phases 0, 1, 3.

- Players: 8 typical, 16 max → §2, §6.6, §7.
- AI: at most 50 alive; horde-style co-op PvE, and 8v8 deathmatch with bots filling the teams → §2 (modes,
  trust), §6.5.1, §6.6.
- Destructible props: not for now → §2 non-goals.
- Hosting: the game developer chooses the provider; Cleo stays cloud-agnostic through a host contract and
  swappable lifecycle / fleet adapters → §7.1, §7.2.

**Open**
1. Which regions do playtesters / first players come from? Decides where the first VPS boxes go.
2. Should deathmatch bots and co-op AI share one brain setup, or do bots need player-like behaviour (strafe,
   use weapons and props)? Affects AI CPU per agent on the host.

## References

- WebTransport: [MDN API](https://developer.mozilla.org/docs/Web/API/WebTransport_API),
  [constructor / serverCertificateHashes](https://developer.mozilla.org/docs/Web/API/WebTransport/WebTransport),
  [datagrams](https://developer.mozilla.org/docs/Web/API/WebTransport/datagrams),
  [Baseline 2026](https://webrtc.ventures/2026/04/webtransport-is-now-baseline-what-it-means-for-real-time-media/),
  [Node host library](https://www.npmjs.com/package/@fails-components/webtransport)
- Prediction / follow: Gambetta, [prediction & reconciliation](https://gabrielgambetta.com/client-side-prediction-server-reconciliation.html),
  [entity interpolation](https://gabrielgambetta.com/entity-interpolation.html),
  [lag compensation](https://gabrielgambetta.com/lag-compensation.html)
- Pulse encoding: Fiedler, [snapshot compression](https://gafferongames.com/post/snapshot_compression/)
- Prior art: Godot [MultiplayerSynchronizer](https://docs.godotengine.org/en/latest/classes/class_multiplayersynchronizer.html),
  Photon Fusion [interpolation](https://doc.photonengine.com/fusion/current/manual/interpolator)
