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

Status: **proof of concept** (`feature/agent-mcp`). Dev builds of the editor only.

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
  - It is started on demand by `ensureHost.mjs`: when the Claude panel opens (via the editor's dev server),
    or when a stdio MCP server starts.
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
- `execute_js` is marked `anthropic/requiresUserInteraction`, so Claude Code asks before every run, whatever
  its permission mode. The editor can refuse it entirely (Agent chip, then **Allow code execution**).

**Leftovers from earlier versions.** An in-editor API-key chat was removed. If you used it,
`~/.cleo/agent-host.json` (its saved API key) and `~/.cleo/agent/` (its working folders) are no longer read
and are safe to delete.

## Tools

The tools marked **core** load with the session (`_meta["anthropic/alwaysLoad"]`), so Claude Code calls them
without a tool-search turn first; the rest load on demand. Node refs everywhere: `"/A/B"` path, `"#id"`, a
unique name, `"$alias"` from an earlier create in the same call, or `"@selected"` (the editor's selection).

| Tool | What it does |
| --- | --- |
| `editor_status` (core) | Project, scenes, active tab, play state, unsaved work, selection. |
| `scene_tree` (core) | Outline of the scene, or a type/name search returning paths and ids; the header names the selection. |
| `node_get` (core) | One node: transform, world bounds, script fields, body, trigger, material, and its **settable props**. |
| `scene_edit` (core) | A batch of ops as one undo step: `create` (from the Add catalog, a template or a model, taking every field `update` does: material, body, script, script fields, props), `update`, `delete`, `move`, `attachScript`, `detachScript`, `select`. A material can be a PBR spec inline. `capture` returns a screenshot of the result. |
| `script_write` (core) / `script_read` | Create or replace a class script and attach it; returns the runtime-compile and TypeScript diagnostics. |
| `material_write` | Create or update a PBR material and assign it; `capture` too. |
| `asset_list` | Templates, models, materials, scripts, clips, brains, particles, sounds, textures, tilesets. |
| `view_capture` (core) | Screenshot of the viewport (the game view during Play), optionally framing a node first. |
| `play_control` (core) | Play, Simulate, pause, stop. Runs for N seconds (returning early on the first error) with the new log lines; `capture` and `stopAfter` make a test run one call. |
| `logs_read` | Console entries after a cursor; repeated lines collapsed. |
| `history` | Undo or redo whole steps. |
| `scene_save` | Save the active tab. |
| `execute_js` | Escape hatch: async JavaScript in the editor page. The user approves every run. |

So *"add a red cube and show me"* is one `scene_edit` (a create op with `material`, `as`, and `capture`), and
*"make the selected node spin"* is `script_write` with `attach: ["@selected"]` plus one `play_control`
`{action: "simulate", capture: true, stopAfter: true}`.

**Speed.** The editor runs changes one at a time (two history transactions at once would merge their undo
steps), but pure reads (`status`, `scene.tree`, `node.get`, `asset.list`, `logs.read`, `script.read`) skip
that queue, so a look at the scene never waits behind a capture, a Play run or a type check. The script type
checker loads in the background after the first call. Results are compact JSON and cut at 40,000 characters,
under Claude Code's 50,000-character limit, past which a result is spilled to a file.

Resources: `cleo://docs/...` (all of `docs/`) and `cleo://examples/scripts/...`.

## Testing

```sh
npm test                    # bridge security, peer relay, the stdio server through the SDK v2 client, the catalog's size budget, hosted terminal (node:test, real sockets, a real pty)
node scripts/smoke.mjs      # end to end through the host against a running editor: inline material + capture, @selected, reads during a script write, a one-call test run, undo (--keep leaves the result)
```

The editor half is tested by `applications/editor/tests/agentBridge.test.ts` and `claudePanel.test.ts`.

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

## Known limits (proof of concept)

- **Dev builds only.** The packaged desktop app has no discovery route or host start yet.
- **One editor per host, newest wins.** A second tab takes the link and the first shows "Agent (other
  tab)".
- **Not undoable:** asset-library changes (new scripts, materials), and property changes made by
  `execute_js`.
- **Missing:** input injection during Play, scene open/create, imports.
- **One hosted Claude Code at a time**, per host. It runs in the engine checkout, not in a folder of the
  project (projects live in IndexedDB).
- **Protocol version.** The stdio server is on MCP SDK v2 (`@modelcontextprotocol/server`); `serveStdio`
  answers both protocol 2026-07-28 clients and 2025-era ones from the same tool catalog.
