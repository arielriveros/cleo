# cleo-mcp

Lets an AI agent drive a **running Cleo editor**: build and change scenes, write and attach scripts (with
type errors reported back), make materials, look at the viewport, play the game and read its logs. It
works live on the project you have open, and each change is one step on the editor's undo stack.

There are two ways in:
- **Claude Code inside the editor.** Click **Claude** in the menu bar. The panel runs the user's own
  `claude` CLI in a terminal, with these tools connected. It signs in with the user's Claude account, so it
  runs on their plan.
- **External agents** such as Claude Code in any terminal or IDE, or Claude Desktop, through the stdio MCP
  server.

Status: cleo-mcp 0.6. Dev builds of the editor only.

## Quick start

```sh
cd applications/mcp && npm install          # once
npm run editor:dev                          # engine root; open a project
```

**Claude Code in the editor:** click **Claude** at the right end of the menu bar. That starts the agent host
and then Claude Code (it must be installed: `claude` on the PATH). The first time, Claude Code asks you to
trust the folder and, if needed, to log in.

**Claude Code elsewhere / Claude Desktop:**
```sh
claude mcp add cleo -- node "<engine>/applications/mcp/src/index.mjs"
```
For Claude Desktop, put the same command in `claude_desktop_config.json` under `mcpServers`.

## How it works

```
 Claude panel ──┐                          Claude Code ── stdio ── index.mjs ─┐ (peer)
 (in the editor)│                          Claude Desktop ─ stdio ─ index.mjs ─┤ (peer)
                ▼                                                               ▼
 Cleo editor ◀──── ws://127.0.0.1 ────▶  agent host (host.mjs)  ◀─────────────┤
 features/agentBridge   (editor connects out)   ├─ bridge.mjs    the one editor link + peer relay
 runs each command,                             └─ terminal.mjs  the user's `claude` in a pty ──┐
 one undo step per call                                          its own index.mjs is a peer ───┘
```

- **The agent host** (`src/host.mjs`) is one long-lived background process that owns the editor link.
  - It is started on demand by `ensureHost.mjs`: when the editor opens a project with the MCP server addon on
    (via the editor's dev server), or when a stdio MCP server starts.
  - It exits after 15 minutes with nothing connected.
  - Its log is `~/.cleo/agent-host.log`.
- **The stdio MCP server** (`src/index.mjs`) is what Claude Code launches. It serves the tool catalog and
  relays every call to the host as a peer, so several Claude sessions share one editor instead of fighting
  over it. `CLEO_MCP_STANDALONE=1` restores the original setup, where the server owns the link itself.
- **The editor** runs every command against the live project
  (`applications/editor/src/features/agentBridge/commands.ts`). The project lives in its IndexedDB and
  React state.
- **Claude Code in the editor** (`src/terminal.mjs`): the host runs the user's own `claude`, unmodified, in
  a pseudo-terminal (node-pty) and streams it to an xterm.js terminal in the panel
  (`features/agentChat/ClaudeCodeView.tsx`, `terminalStore.ts`, `panelStore.ts`).
  - It is started with `--mcp-config` naming this checkout's stdio server, so the session gets the Cleo
    tools whatever is configured, `--allowedTools "mcp__cleo__*"` so they run without a permission prompt
    each (every change is still one undo step; `execute_js` asks every time regardless), and a short
    `--append-system-prompt` saying it runs inside the editor. It starts in the engine checkout
    (`CLEO_CLAUDE_CWD` to change it).
  - It signs in the way Claude Code always does: its own login, through Anthropic. The host never reads,
    stores or passes on a credential, and nothing limits how Claude Code signs in. That is what lets it run
    on the user's Claude plan.
  - A headless xterm in the host mirrors the screen, so an editor that reloads (or a second tab) gets the
    exact screen back as a serialized snapshot.
  - A parent Claude Code session's variables (`CLAUDECODE`, its session id, its messaging socket) are
    removed from the host and from the hosted session: the host is often started by one such session's MCP
    server but outlives it (`src/env.mjs`).
  - The session keeps running with the panel closed. It is stopped once no editor has been connected for
    `CLEO_AGENT_HOST_IDLE_MS`, since its own MCP server would otherwise keep the host up for good.
- **Versions.** The host's version is in the discovery file. A stdio server or a dev server that finds an
  OLDER host running replaces it (`ensureHost({ replaceOutdated })`), never a newer one. The MCP server of a
  session the host runs itself (`CLEO_HOSTED_BY`) never replaces it: that would kill its own terminal.

**Discovery.** The host writes `~/.cleo/agent-bridge.json` containing `{role, port, token, pid, version}`.
The editor's Vite dev server serves it to its own pages at `GET /__cleo/agent-bridge`. `POST
/__cleo/agent-host/start` starts the host. Both routes are in `agentBridgeDiscoveryPlugin` in
`applications/app-kit/vite.preset.ts`, and both refuse cross-site requests.

**Security.**
- The host listens on loopback only.
- The Host header must name a loopback address, which stops DNS rebinding.
- A browser Origin must be a local editor origin or the desktop app's `app://editor`.
- The first frame must carry the token from the discovery file. This closes the holes behind
  CVE-2025-52882 and CVE-2025-49596.
- `execute_js` runs without a per-call prompt in the hosted session (the Cleo tools are allowed there), and
  under an external session's own permission rules. The editor can refuse it entirely (Agent chip, then
  **Allow code execution**).

**Leftovers from earlier versions.** An in-editor API-key chat was removed. If you used it,
`~/.cleo/agent-host.json` (its saved API key) and `~/.cleo/agent/` (its working folders) are no longer read
and are safe to delete.

## Tools

Every tool loads with the session (`_meta["anthropic/alwaysLoad"]`): the whole catalog is about 6k tokens,
less than the tool-search turn a deferred tool costs on its first use. Inputs are strict: a field a tool
does not take is refused by name, never dropped. Node refs everywhere: `"/A/B"` path, `"#id"`, a unique
name, `"$alias"` from an earlier create in the same call, or `"@selected"` (the editor's selection).

| Tool | What it does |
| --- | --- |
| `editor_status` | Project, scenes, active tab and its kind, the scene's dimension (2D/3D), play state (and a game in its own window), the viewport's split, unsaved work, selection. |
| `scene_tree` | Outline of the scene, or a type/name search returning paths and ids; the header names the selection and the dimension. `with` adds world position, size or id to each line. |
| `node_get` | One node or several (`nodes`), with `fields` to pick parts: transform, world bounds, children, script fields, shapes, material (type, properties, textures by name), linked assets (tileset, sprite clips, sequence, effect, tilemap layers), variables, and its **settable props**. |
| `scene_edit` | A batch of ops as one undo step, **all or nothing** (`atomic: false` keeps the ops before a failure): `create` (from the Add catalog, a template or a model, taking every field `update` does: material, shapes, script, script fields, props, asset links), `update`, `delete`, `move`, `attachScript`, `detachScript`, `select`, and for templates `makeTemplate`, `unpack`, `revertOverrides`, `makeVariant`. Every op's fields are checked before any op runs. `capture` returns a screenshot of the result. |
| `script_write` / `script_read` | Create or replace a class script, or patch it with exact `edits`, and attach it; returns the runtime-compile and TypeScript diagnostics. One undo step, the asset included. |
| `material_write` | Create or update a material, PBR, cel, foliage or unlit, with texture slots by texture name and any other property by name; answers with every property. Updates reach everything using it. One undo step. |
| `asset_list` | Templates, models, materials, landscape materials, scripts, clips, animation fields, controllers, rigs, brains, particles, sequences, sounds, textures, tilesets; `ids` adds ids. |
| `view_capture` | Screenshot of the viewport (the game view during Play): the editing pane of a split view (`pane: "all"` for every pane), optionally framing a node, from up to four angles in one image (`views: "quad"`). |
| `play_control` | Play, Simulate, `run` (keep a running game going), pause, stop. A run lasts N seconds (returning early on the first error) with the new log lines; `input` presses keys, mouse buttons and project actions in the game, `watch` samples nodes as numbers (position, yaw, velocity, grounded, animation state, named props); `capture` and `stopAfter` make a test one call. A game in its own window is stopped or paused from here. |
| `workspace` | Scenes and tabs: list, open, create, rename, set main, duplicate, switch 2D/3D; open an asset in its tab (a template or model tab is then what `scene_edit` edits), switch and close tabs. Leaving unsaved work takes `unsaved: "save"` or `"discard"`. |
| `logs_read` | Console entries after a cursor; repeated lines collapsed. A window game's logs (`Game/<scope>`) match their plain scope. |
| `history` | Undo or redo whole steps (not during Play). |
| `scene_save` | Save the active tab. |
| `execute_js` | Escape hatch: async JavaScript in the editor page; `await track(node)` before changing a node makes the change undoable. |
| `engine_api` | The scripting API and docs as small lookups, answered by the server itself (no editor needed): a word search, a class with every member, one member's signatures and doc, or one docs section. |

So *"add a red cube and show me"* is one `scene_edit` (a create op with `material`, `as`, and `capture`),
*"make the selected node spin"* is `script_write` with `attach: ["@selected"]` plus one `play_control`
`{action: "simulate", capture: true, stopAfter: true}`, and *"prove the player walks forward"* is one
`play_control {action: "play", input: [{at: 0.2, key: "KeyW", hold: 1.5}], watch: ["/Player"], stopAfter: true}`
answered with the distance it moved.

**Speed.** The editor runs changes one at a time (two history transactions at once would merge their undo
steps), but pure reads (`status`, `scene.tree`, `node.get`, `asset.list`, `logs.read`, `script.read`) skip
that queue, so a look at the scene never waits behind a capture, a Play run or a type check. The script type
checker loads in the background after the first call. Results are compact JSON and cut at 40,000 characters,
under Claude Code's 50,000-character limit, past which a result is spilled to a file.

**Cancelling.** A call the client cancels (Esc in Claude Code) is cancelled through the whole chain: the
stdio server passes the request's abort signal to its link, a peer sends `{type:'cancel', id}` to the host,
the host to the editor, and the editor stops the command (a play run lets go of its keys and stops the
game; a change still queued never starts).

**Precision.** `scene_edit` checks every op's fields before running any, then runs them in one transaction
that is rolled back whole if an op fails (`HistoryContext.transaction(..., {atomic: true})`,
`HistoryManager.rollbackBatch`). Asset-library changes are undo entries of the same step, pushed under the
node changes (`pushFirst`), so undo removes a new material only once no node uses it. `props` never write
over an object or an empty link (a sprite's tileset has its own `assets` field), and a miss names the
nearest property. The Add types and asset kinds the schemas list live in `src/catalog.mjs`, which the
editor suite checks against the real catalog (`applications/editor/tests/agentCatalog.test.ts`).

**Engine API lookup** (`src/engineApi.mjs`). `engine_api` answers from the engine's own type declarations
(`dist/**/*.d.ts`, written by `npm run build`): exactly what `import { ... } from 'cleo'` gives a script and
what `script_write` type-checks against, with the engine's JSDoc. The docs come along split at their
headings.
- The index (about 5,800 symbols and 800 doc sections) is built with the TypeScript compiler in under 2 s.
  It is cached in `~/.cleo/engine-api/`, keyed by the size and time of every declaration and doc file, and
  loads from there in about 0.2 s. The stdio server loads it at startup, off the first lookup's path.
- Answers stay small. A search is under 3,500 characters, and a whole class is listed by name (all 146
  members of `Node` in 2.6k) when signatures would not fit. A docs section replaces reading a 10–43k file.
- When the engine source is newer than its declarations, answers say to run `npm run build`.

Resources: `cleo://docs/...` (all of `docs/`) and `cleo://examples/...` (each example project folder's scripts and docs).

## Testing

```sh
npm test                    # bridge security, peer relay and cancel, the stdio server through the SDK v2 client (strict inputs), the catalog's size budget, hosted terminal (node:test, real sockets, a real pty)
node scripts/smoke.mjs      # end to end through the host against a running editor (its MCP server addon on): an atomic failure, a quad capture, a cel material, a script patched, a WASD run checked by its numbers, a cancelled run, makeTemplate, undo of all of it (--keep leaves the result, --workspace also makes a scene)
```

The editor half is tested by `applications/editor/tests/agentBridge.test.ts` (refs, props, materials, op
fields), `agentPlayInput.test.ts` (input plans, traces, script patches, pane crops), `agentCatalog.test.ts`
(the catalog against the editor), `agentFrameNode.test.ts` and `claudePanel.test.ts`.

To run the smoke test beside a session you are using, give it its own host and editor: start an editor dev
server and the smoke script with `CLEO_AGENT_BRIDGE_FILE` and `CLEO_MCP_PORT` pointing elsewhere (and
`CLEO_CLAUDE_PATH` at a stand-in, so the panel does not start a real Claude Code).

## Environment

| Variable | Default | |
| --- | --- | --- |
| `CLEO_MCP_PORT` | `47615` | Bridge port. If it is busy, a free one is taken, and the discovery file says which. |
| `CLEO_AGENT_BRIDGE_FILE` | `~/.cleo/agent-bridge.json` | The discovery file. The host's log and the hosted session's MCP config sit next to it. |
| `CLEO_AGENT_HOST_IDLE_MS` | 15 min | How long the host waits with nothing connected before it exits; also how long a hosted Claude Code keeps running after the last editor left. |
| `CLEO_CLAUDE_PATH` | (the PATH) | The `claude` the editor's Claude panel runs. |
| `CLEO_CLAUDE_CWD` | the engine checkout | The folder it starts in. |
| `CLEO_MCP_STANDALONE` | (off) | `1`: the stdio server owns the editor link itself, with no host. |
| `CLEO_MCP_ALLOWED_ORIGINS` | (none) | Extra exact origins allowed to connect, comma-separated. |

## Known limits

- **Dev builds only.** The packaged desktop app has no discovery route or host start yet.
- **One editor per host, newest wins.** A second tab takes the link and the first shows "Agent (other
  tab)".
- **Not undoable:** property changes `execute_js` makes without `track`, a new or duplicated scene, a
  scene rename or main-scene change.
- **Input:** keys, mouse buttons, movement and wheel, and project actions through their key or mouse
  binding. No gamepad, and no pointer lock (a browser grants it only to a real click).
- **Window play** is outside the agent's reach except stop and pause: the game runs in another process.
- **Missing:** imports, tilemap painting, custom (shader) materials and screen materials, bakes.
- **One hosted Claude Code at a time**, per host. It runs in the engine checkout, not in a folder of the
  project (projects live in IndexedDB).
- **Protocol version.** The stdio server is on MCP SDK v2 (`@modelcontextprotocol/server`); `serveStdio`
  answers both protocol 2026-07-28 clients and 2025-era ones from the same tool catalog.
