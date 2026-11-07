# cleo-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent drive a
**running Cleo editor**. With it, Claude Code or Claude Desktop can:

- build and change scenes
- write and attach scripts, with type errors reported back
- make materials
- look at the viewport
- play the game and read its logs

Everything happens live in the project you have open, and each change is one step on the editor's undo
stack.

Status: **proof of concept** (`feature/agent-mcp`). Dev builds of the editor only.

## Quick start (Claude Code)

```sh
cd applications/mcp && npm install          # once
claude mcp add cleo -- node "<engine>/applications/mcp/src/index.mjs"
```

1. Start the editor (`npm run editor:dev` at the engine root) and open a project.
2. Start Claude Code. Within a few seconds an **Agent** chip appears in the editor's menu bar, with a
   green dot once it is linked.
3. Ask for something, for example: *"Add a ground plane, a red cube that spins, and a camera looking at
   it, then play it and show me."*

For Claude Desktop, add the same command to `claude_desktop_config.json` under `mcpServers`.

## How it works

```
Claude Code / Claude Desktop
        │  MCP over stdio
cleo-mcp (this package)           tool schemas and descriptions, docs as resources
        │  ws://127.0.0.1:47615   per-launch token, Origin and Host checks
        ▲  the editor connects OUT (a web page cannot listen)
Cleo editor (browser or Electron)
  features/agentBridge/           runs each command against the live project,
                                  one at a time, each as one undo step
```

The project lives in the editor's IndexedDB and its React state, so the commands run inside the
editor (`applications/editor/src/features/agentBridge/commands.ts`). This server only relays them. Its
own job is the protocol, the tool catalog (`src/tools.mjs`) and the docs resources (`src/resources.mjs`).

**Discovery.** On start the server writes `~/.cleo/agent-bridge.json` containing `{port, token, pid}`.
The editor's Vite dev server serves that file back to its own pages at `/__cleo/agent-bridge` (see
`agentBridgeDiscoveryPlugin` in `applications/app-kit/vite.preset.ts`). The editor polls that route,
connects, and authenticates with the token.

**Security.** The bridge is closed against the holes found in earlier localhost bridges
(CVE-2025-52882, CVE-2025-49596):
- It listens on loopback only.
- The Host header must name a loopback address, which stops DNS rebinding.
- A browser Origin must be a local editor origin (`http://localhost:*`, `http://127.0.0.1:*`) or the
  desktop app's `app://editor`.
- The first frame must carry the token, which only the discovery file holds.
- The discovery route refuses cross-site fetches.
- `execute_js` is marked `anthropic/requiresUserInteraction`, so Claude Code asks before every run.
  It can also be switched off in the editor (Agent chip, then **Allow code execution**).

## Tools

| Tool | What it does |
| --- | --- |
| `editor_status` | Project, scenes, active tab, play state, unsaved work, selection. Always loaded. |
| `scene_tree` | Outline of the scene, or a type/name search returning paths and ids. |
| `node_get` | One node: transform, script fields, body, trigger, material, its **settable props**. |
| `scene_edit` | A batch of ops as one undo step: `create` (Add catalog / template / model), `update` (transform, props, script fields, material, body, trigger), `delete`, `move`, `attachScript`, `detachScript`, `select`. |
| `script_write` / `script_read` | Create or replace a class script, attach it, and return the runtime-compile and TypeScript diagnostics (Monaco's checker, same as the script tab). |
| `material_write` | Create or update a PBR material and assign it. |
| `asset_list` | Templates, models, materials, scripts, clips, brains, particles, sounds, textures, tilesets. |
| `view_capture` | Screenshot of the viewport (the game view during Play), optionally framing a node first. |
| `play_control` | Play / Simulate / pause / stop. Can run N seconds and return the new log lines. |
| `logs_read` | Console entries after a cursor, filtered by level or scope. |
| `history` | Undo or redo the agent's (or your) steps. |
| `scene_save` | Save the active tab. |
| `execute_js` | Escape hatch: async JavaScript in the editor page, with `cleo`, `engine`, `scene`, `editor`, `find`, `log` in scope. |

Nodes are addressed by `/Parent/Child` path, `#id`, a unique bare name, or a `$alias` set by an
earlier `create` in the same `scene_edit` call.

Resources: `cleo://docs/...` (all of `docs/`) and `cleo://examples/scripts/...`.

## Testing

```sh
npm test                   # bridge security and relay (node:test, real sockets)
node scripts/smoke.mjs     # end to end against a running editor; --keep leaves the result in place
```

The editor half has unit tests in `applications/editor/tests/agentBridge.test.ts`.

## Environment

| Variable | Default | |
| --- | --- | --- |
| `CLEO_MCP_PORT` | `47615` | Bridge port. If it is busy, any free port is taken, and the discovery file says which. |
| `CLEO_AGENT_BRIDGE_FILE` | `~/.cleo/agent-bridge.json` | Must match on the server and the editor's dev server. |
| `CLEO_MCP_ALLOWED_ORIGINS` | (none) | Extra exact origins allowed to connect, comma-separated. |
| `CLEO_ENGINE_ROOT` | the checkout | Where the docs resources are read from. |

## Known limits (proof of concept)

- **Dev builds only.** The packaged desktop app has no discovery route yet; it needs a preload call
  that reads the same file.
- **One editor per server, newest wins.** A second editor tab takes the link, and the first shows
  "Agent (other tab)" with a button to take it back. If two servers run (two Claude sessions), the
  editor follows whichever wrote the discovery file last.
- **What is not undoable:** asset-library changes (new scripts, materials) are not on the undo stack.
  Neither are property changes made through `execute_js`; its structure changes are.
- **What is missing:** input injection during Play, scene open/create, model and texture import,
  and templates made from nodes. `execute_js` covers some of this meanwhile.
- **Protocol version.** The server is built on SDK v1 (protocol 2025-11-25). SDK v2 (protocol
  2026-07-28) is the next step.
