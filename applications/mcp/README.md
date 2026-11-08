# cleo-mcp

Lets an AI agent drive a **running Cleo editor**: build and change scenes, write and attach scripts (with
type errors reported back), make materials, look at the viewport, play the game and read its logs. It
works live on the project you have open, and each change is one step on the editor's undo stack.

There are three ways in:
- **Claude Code inside the editor.** Click **Claude** in the menu bar; the **Claude Code** tab runs the
  user's own `claude` CLI in a terminal, with these tools connected. It signs in with the user's Claude
  account, so it runs on their plan.
- **The API chat inside the editor**, the panel's other tab. It runs Claude through the Claude Agent SDK
  on an Anthropic API key, with the same tools.
- **External agents** such as Claude Code or Claude Desktop, through the stdio MCP server.

Status: **proof of concept** (`feature/agent-mcp`). Dev builds of the editor only.

## Quick start

```sh
cd applications/mcp && npm install          # once
npm run editor:dev                          # engine root; open a project
```

**Claude Code in the editor:** click **Claude** at the right end of the menu bar. The **Claude Code** tab
starts the agent host and then Claude Code (it must be installed: `claude` on the PATH). The first time,
Claude Code asks you to trust the folder and, if needed, to log in.

**API chat:** the panel's **API chat** tab. Paste an Anthropic API key the first time (or set
`ANTHROPIC_API_KEY` before starting the editor).

**Claude Code / Claude Desktop:**
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
 runs each command,                             ├─ chat.mjs      Agent SDK sessions for the API chat
 one undo step per call                         └─ terminal.mjs  the user's `claude` in a pty ──┐
                                                                 its own index.mjs is a peer ───┘
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
- **Claude Code in the editor** (`src/terminal.mjs`): the host runs the user's own `claude`, unmodified, in
  a pseudo-terminal (node-pty) and streams it to an xterm.js terminal in the panel
  (`features/agentChat/ClaudeCodeView.tsx`, `terminalStore.ts`).
  - It is started with `--mcp-config` naming this checkout's stdio server, so the session gets the Cleo
    tools whatever is configured, plus a short `--append-system-prompt` saying it runs inside the editor.
    It starts in the engine checkout (`CLEO_CLAUDE_CWD` to change it).
  - It signs in the way Claude Code always does: its own login, through Anthropic. The host never reads,
    stores or passes on a credential, and nothing limits how Claude Code signs in. That is what lets it run
    on the user's Claude plan, which an app built on the Agent SDK may not.
  - A headless xterm in the host mirrors the screen, so an editor that reloads (or a second tab) gets the
    exact screen back as a serialized snapshot.
  - A parent Claude Code session's variables (`CLAUDECODE`, its session id, its messaging socket) are
    removed from the host and from the hosted session: the host is often started by one such session's MCP
    server but outlives it (`src/env.mjs`).
  - The session keeps running with the panel closed. It is stopped once no editor has been connected for
    `CLEO_AGENT_HOST_IDLE_MS`, since its own MCP server would otherwise keep the host up for good.
- **Versions.** The host's version is in the discovery file. A stdio server or a dev server that finds an
  OLDER host running replaces it (`ensureHost({ replaceOutdated })`), never a newer one.

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
npm test                    # bridge security, peer relay, normalizer, chat flows, hosted terminal (node:test, real sockets, a real pty)
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
| `CLEO_AGENT_HOST_IDLE_MS` | 15 min | How long the host waits with nothing connected before it exits; also how long a hosted Claude Code keeps running after the last editor left. |
| `CLEO_CLAUDE_PATH` | (the PATH) | The `claude` the editor's Claude Code tab runs. |
| `CLEO_CLAUDE_CWD` | the engine checkout | The folder it starts in. |
| `CLEO_AGENT_MOCK` | (off) | `1`: the chat runs a scripted agent that uses the real tools. For tests. |
| `CLEO_MCP_STANDALONE` | (off) | `1`: the stdio server owns the editor link itself, with no host. |
| `CLEO_MCP_ALLOWED_ORIGINS` | (none) | Extra exact origins allowed to connect, comma-separated. |

## Known limits (proof of concept)

- **Dev builds only.** The packaged desktop app has no discovery route or host start yet.
- **One editor per host, newest wins.** A second tab takes the link and the first shows "Agent (other
  tab)".
- **Not undoable:** asset-library changes (new scripts, materials), and property changes made by
  `execute_js`.
- **Missing:** input injection during Play, scene open/create, imports. The API chat cannot attach images
  or files yet.
- **One hosted Claude Code at a time**, per host. It runs in the engine checkout, not in a folder of the
  project (projects live in IndexedDB).
- **Protocol version.** The stdio server is on MCP SDK v1 (protocol 2025-11-25).
