# Multiplayer

Cleo games play online through **NetSync**: the game runs on a dedicated host, and every player's browser (or
desktop build) joins it. The host decides what happens; each player sees the host's world and drives their own
character at once, without waiting for the host to answer. How it works inside is in
[the design](../design/netsync.md); this page is about making a game for it in the editor.

## Turning it on

**Options › Project › NetSync › Online play** makes the project an online game. The rest of that page — tick
rate, players per session, the player template and spawn point, trust, and the allocator a published page asks for
a host — is described in [Options](options.md#netsync).

A joining player gets a character the level placed for a player (a Character driven by a Controller whose control
is *Player*) while one is free, then a copy of the **Player template** at the **Spawn point**. When the player
leaves, the copy goes and a level character waits for the next one.

## What the host sends its players

Not everything: a node is sent only when something about it can change on the host. Automatically:

- every **Character**, with its animation (states, parameters, actions);
- every **Collider with mass** (a prop that falls, rolls and gets pushed), at rest only when it moves again;
- every node whose script has **`@synced`** fields or **`@netcall`** methods (see
  [Scripting › Multiplayer](../scripting/multiplayer.md)).

Anything else is sent only when its **NetSync › Synced** switch is on in the [inspector](node-inspector.md); with
Online play on, every node shows that section, and says why it syncs or that it does not. A node that does not
sync is seen by every player as the level placed it: right for walls and floors, wrong for a door a script swings
on the host.

## Play › Multiplayer

Plays the game online on this machine: a local host and a game window per player, each joined to it as a
published page would be. It is under the Play button's menu (the arrow beside it).

1. The **dev host** runs the game for the players, on `http://127.0.0.1:4490`. In the **desktop editor** it starts
   by itself when the dialog opens (or on **Check**) and stops when the editor quits: nothing to run. The first
   start from the repository takes about half a minute, while the engine compiles. In a **browser**, start it once
   in a terminal at the repository: `npm run host -- --dev` (in PowerShell, `npm.cmd run host -- --dev`:
   PowerShell's `npm` drops the `--`, and a host without `--dev` is not one the editor can use). The dot beside
   **Dev host** turns green when the editor reaches it.
2. Set up the **players**: a name, the **Link** — *WebTransport* (the normal path, falling back to WebSocket when
   it cannot), or *WebSocket (fallback)* to play the fallback on purpose — and a worse network than this machine
   has: **Lag** (ms added each way), **Jitter** (ms of random extra) and **Loss** (% of the player's state
   updates lost). Up to 8.
3. **Start.** The windows open at once, spread across the screen, and show their loading screens while the game is
   built (as Play in window builds it); the dev host then runs it and every window joins. In a browser, one click
   may open only one pop-up: the other players' rows then say the pop-up was blocked, with an **Open** button
   each (one click per window). To have Start open them all, allow pop-ups for the editor's page once (the
   blocked pop-up icon at the right of the address bar › Always allow). A window you close gets an **Open** too.

While it runs, the dialog shows the **NetSync readings**:

- **Host** — its state and scene, how long a tick takes (mean and 95th percentile against the tick budget),
  ticks it skipped because it fell behind, how many nodes it syncs, how many players it has, and the most bytes it
  sent one player in a tick.
- **Each player** — its peer number, its link (and why it fell back, on hover), its round trip, how many of the
  host's states its prediction had to correct, and the largest error it corrected.

**Stop** closes the windows and the host's game. A change in the editor reaches the game on the next Start.

## Firing Line online, from the example to a VPS

The Firing Line example is an online game already (see [its notes](fps-example.md#online)). To play it with
friends on a server of your own:

1. **Open it**: the projects list › Examples › Firing Line.
2. **Try it here**: Play's menu › **Multiplayer…** (in a browser, start the dev host first:
   `npm run host -- --dev`) with two
   players or more. Set **Options › Project › NetSync › Game mode** to `coop` (the players against a horde of
   bots) or `deathmatch` (eight against eight, bots in the empty seats) first.
3. **Name the allocator**: Options › Project › NetSync › **Allocator** `https://play.example.com` (your domain).
4. **Publish › Web**, then publish the host from the same build:
   `npm run publish-host -- --game <the web build's folder> --out firing-line-host`.
5. **Deploy** the host folder on a VPS: [Hosting › One VPS, step by step](../reference/netsync-hosting.md#one-vps-step-by-step).
6. **Play**: put the web build online and open it. Every player who opens it is sent to a session of the
   project's game mode; add `?mode=deathmatch` (or `coop`) to the address to choose, and `?name=…` for a name.

## Publishing

- **Publish › Web** builds the page players open (with Online play on, it asks the allocator for a host).
- The host is published from the repository for now: `npm run publish-host -- --game <the web build's folder>
  --out <folder>` writes a folder with the built host, the same game, a Dockerfile and a template for each kind of
  hosting (one VPS with Docker or systemd, Kubernetes with Agones, Edgegap). Its README says which to start from,
  and [Hosting](../reference/netsync-hosting.md) explains the pieces and every setting.
