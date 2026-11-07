# cleo-mcp

Lets an AI agent drive a **running Cleo editor**: build and change scenes, write and attach scripts (with
type errors reported back), make materials, look at the viewport, play the game and read its logs. It
works live on the project you have open, and each change is one step on the editor's undo stack.

There are two ways in:
- **The Claude chat inside the editor.** Click **Claude** in the menu bar. It runs Claude through the
  Claude Agent SDK with the same tools.
- **External agents** such as Claude Code or Claude Desktop, through the stdio MCP server.

Status: **proof of concept** (`feature/agent-mcp`). Dev builds of the editor only.

## Quick start

```sh
cd applications/mcp && npm install          # once
npm run editor:dev                          # engine root; open a project
```

**In-editor chat:** click **Claude** at the right end of the menu bar and paste an Anthropic API key the
first time (or set `ANTHROPIC_API_KEY` before starting the editor). Opening the panel starts the agent
host.

**Claude Code / Claude Desktop:**
```sh
claude mcp add cleo -- node "<engine>/applications/mcp/src/index.mjs"
```
For Claude Desktop, put the same command in `claude_desktop_config.json` under `mcpServers`.

## How it works

```
 Claude chat panel ──┐                     Claude Code ── stdio ── index.mjs ─┐ (peer)
 (in the editor)     │                     Claude Desktop ─ stdio ─ index.mjs ─┤ (peer)
                     ▼                                                          ▼
 Cleo editor ◀──── ws://127.0.0.1 ────▶  agent host (host.mjs)  ◀─────────────┘
 features/agentBridge   (editor connects out)   ├─ bridge.mjs   the one editor link + peer relay
 runs each command,                             └─ chat.mjs     Claude Agent SDK sessions for the panel
 one undo step per call
```

- **The agent host** (`src/host.mjs`) is one long-lived background process that owns the editor link.
  - It is started on demand by `ensureHost.mjs`: when the chat panel opens (via the editor's dev server),
    or when a stdio MCP server starts.
  - It exits after 15 minutes with nothing connected.
  - Its log is `~/.cleo/agent-host.log`.
- **The stdio MCP server** (`src/index.mjs`) is what Claude Code launches. It serves the tool catalog and
  relays every call to the host as a peer. So several Claude sessions and the chat share one editor
  instead of fighting over it. `CLEO_MCP_STANDALONE=1` restores the original setup, where the server
  owns the link itself.
- **The editor** runs every command against the live project
  (`applications/editor/src/features/agentBridge/commands.ts`). The project lives in its IndexedDB and
  React state.
- **The chat** (`src/chat.mjs`) runs Claude through the Claude Agent SDK.
  - The Cleo tools are an in-process SDK MCP server, built from the same definitions as the stdio server
    (`toolDefinitions` in `src/tools.mjs`).
  - Claude Code's own built-in tools are off. User and project settings are not loaded. There is one
    working directory, and so one session history, per project (`~/.cleo/agent/<projectId>`).
  - Events stream to the panel (`features/agentChat/`). The host keeps the conversation, so a reload
    replays it.

**Discovery.** The host writes `~/.cleo/agent-bridge.json` containing `{role, port, token, pid}`. The
editor's Vite dev server serves it to its own pages at `GET /__cleo/agent-bridge`. `POST
/__cleo/agent-host/start` starts the host. Both routes are in `agentBridgeDiscoveryPlugin` in
`applications/app-kit/vite.preset.ts`, and both refuse cross-site requests.

**Security.**
- The host listens on loopback only.
- The Host header must name a loopback address, which stops DNS rebinding.
- A browser Origin must be a local editor origin or the desktop app's `app://editor`.
- The first frame must carry the token from the discovery file. This closes the holes behind
  CVE-2025-52882 and CVE-2025-49596.
- `execute_js` is marked `anthropic/requiresUserInteraction` for Claude Code. In the chat it always asks.
  The editor can refuse it entirely (Agent chip, then **Allow code execution**).

**Authentication (chat).** The chat uses an Anthropic **API key** only:
- `ANTHROPIC_API_KEY`, or a key saved from the panel into `~/.cleo/agent-host.json` (mode 600).
- Anthropic does not allow third-party products to offer claude.ai login. The Agent SDK runs the Claude
  Code binary, which would otherwise fall back to the machine's Claude.ai login. So the host passes the
  key explicitly, strips inherited Claude Code variables, and stops any session whose init message
  reports a credential source other than `ANTHROPIC_API_KEY`.

## Tools

| Tool | What it does |
| --- | --- |
| `editor_status` | Project, scenes, active tab, play state, unsaved work, selection. Always loaded. |
| `scene_tree` | Outline of the scene, or a type/name search returning paths and ids. |
| `node_get` | One node: transform, script fields, body, trigger, material, and its **settable props**. |
| `scene_edit` | A batch of ops as one undo step: `create` (from the Add catalog, a template or a model), `update` (transform, props, script fields, material, body, trigger), `delete`, `move`, `attachScript`, `detachScript`, `select`. |
| `script_write` / `script_read` | Create or replace a class script and attach it; returns the runtime-compile and TypeScript diagnostics. |
| `material_write` | Create or update a PBR material and assign it. |
| `asset_list` | Templates, models, materials, scripts, clips, brains, particles, sounds, textures, tilesets. |
| `view_capture` | Screenshot of the viewport (the game view during Play), optionally framing a node first. |
| `play_control` | Play, Simulate, pause, stop. Can run for N seconds and return the new log lines. |
| `logs_read` | Console entries after a cursor. |
| `history` | Undo or redo whole steps. |
| `scene_save` | Save the active tab. |
| `execute_js` | Escape hatch: async JavaScript in the editor page. |

Resources: `cleo://docs/...` (all of `docs/`) and `cleo://examples/scripts/...`.

## Testing

```sh
npm test                    # bridge security, peer relay, normalizer, chat flows (node:test, real sockets)
node scripts/smoke.mjs      # end to end through the host against a running editor (--keep leaves the result)
CLEO_AGENT_MOCK=1 npm run editor:dev   # engine root: the chat runs a scripted agent; no API key needed
```

The editor half is tested by `applications/editor/tests/agentBridge.test.ts` and `agentChat.test.ts`.

## Environment

| Variable | Default | |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (none) | The chat's key; takes precedence over one saved from the panel. |
| `CLEO_MCP_PORT` | `47615` | Bridge port. If it is busy, a free one is taken, and the discovery file says which. |
| `CLEO_AGENT_BRIDGE_FILE` | `~/.cleo/agent-bridge.json` | The discovery file. The host's data (key, log, chat working directories) sits next to it. |
| `CLEO_AGENT_HOST_IDLE_MS` | 15 min | How long the host waits with nothing connected before it exits. |
| `CLEO_AGENT_MOCK` | (off) | `1`: the chat runs a scripted agent that uses the real tools. For tests. |
| `CLEO_MCP_STANDALONE` | (off) | `1`: the stdio server owns the editor link itself, with no host. |
| `CLEO_MCP_ALLOWED_ORIGINS` | (none) | Extra exact origins allowed to connect, comma-separated. |

## Known limits (proof of concept)

- **Dev builds only.** The packaged desktop app has no discovery route or host start yet.
- **One editor per host, newest wins.** A second tab takes the link and the first shows "Agent (other
  tab)".
- **Not undoable:** asset-library changes (new scripts, materials), and property changes made by
  `execute_js`.
- **Missing:** input injection during Play, scene open/create, imports. The chat cannot attach images or
  files yet.
- **Protocol version.** The stdio server is on MCP SDK v1 (protocol 2025-11-25).
