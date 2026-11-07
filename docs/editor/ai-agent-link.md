# AI agent link (MCP)

*Unreleased, proof of concept: dev builds of the editor only.*

An AI agent such as Claude Code or Claude Desktop can work in the editor alongside you. It can:

- build scenes, add nodes and change their properties
- write scripts and attach them to nodes
- make materials
- take screenshots of the viewport
- play the game and read its console

There are two ways to work with it:

- **The Claude chat, inside the editor.** Click **Claude** at the right end of the menu bar.
- **An external agent**, such as Claude Code in a terminal or VS Code, or Claude Desktop, connected
  through the **Cleo MCP server** (`applications/mcp`).

Both go through the **Cleo agent host**, a small background program that holds the editor's link. It
carries out each request on the project you have open, and it lets the chat and any number of external
agents share one editor.

## Setting it up

1. Install the agent package once: `cd applications/mcp && npm install`.
2. Start the editor (`npm run editor:dev`) and open a project.

That is enough for the chat: opening it starts the agent host. For an external agent, also register the
MCP server with it. For Claude Code:
`claude mcp add cleo -- node <engine>/applications/mcp/src/index.mjs`.

## The Claude chat

**Claude** in the menu bar opens the chat at the right edge of the editor. It stays open in every mode and
during Play. Drag its left edge to resize it.

- **API key.** The chat runs Claude with your own Anthropic API key, from the Claude Console. The first
  time you open it, it asks for the key and stores it on this machine only, in `~/.cleo/agent-host.json`.
  If `ANTHROPIC_API_KEY` was set before the editor started, that key is used instead. A Claude.ai
  subscription login is not used.
- **What it knows.** Each message carries the open tab, the selected node and whether the game is running.
  So *"make this spin"* means the selection.
- **What it does.** Claude uses the same tools as an external agent. Each tool call shows as a card that
  opens to show what it sent and what came back. Screenshots it takes appear in the conversation.
- **Model.** Choose Opus 5.5 (the default), Sonnet 5.5, Haiku 5.5 or Fable 5.1 in the panel header.
- **Edit automatically / Ask before edits.** In the first mode, Claude changes the project without
  asking, and each change is still one undo step. In the second, every change waits for **Allow**,
  **Always allow in this chat** or **Deny**. Looking at the project never asks. Running code always does.
- **Stop** interrupts Claude mid-task. **New conversation** (+) starts over. **Past conversations**
  (the clock) reopens an earlier one for this project and continues it.
- **Reloads keep the conversation.** The agent host holds it, so a reload or a crash of the editor tab
  brings the conversation back, and Claude keeps working meanwhile.

## The Agent chip

**Agent** sits in the menu bar while the agent host (or a Cleo MCP server) is running on this machine. Its dot shows the state
of the link:

| State | Meaning |
|---|---|
| Green dot | Linked. The agent's commands run in this editor. The dot pulses while one is running. |
| **Agent off** | You disconnected. Click the chip, then **Connect**. |
| **Agent (other tab)** | Another editor tab holds the link. Click the chip, then **Use this tab**. |
| **Agent refused** | The server did not accept this editor, usually because the server was restarted. Click the chip, then **Connect**. |

The chip's menu shows how many commands have run and the last one. It also has two controls:

- **Allow code execution** lets the agent run its own JavaScript inside the editor, for jobs no other tool
  covers. Turn it off to refuse those requests. Claude Code also asks you before each run.
- **Disconnect** stops the link until you connect again.

## What to expect

- **Edits land on your undo stack.** Each request the agent makes is one step, labelled with what it did,
  so Ctrl+Z reverts the whole request. Asset-library changes, such as a new script or material, are not
  undoable this way. Delete those from the explorer.
- **Nothing is saved until someone saves.** The agent's edits mark the tab unsaved like yours do. The
  agent saves only when asked.
- **Play stays separate.** While the game runs, the agent can watch it, capture it and read its logs, but
  it cannot edit the scene. Stop discards anything changed during play, as it does for you.
- **Screenshots can move the editor camera.** When the agent frames a node to look at it, your view moves
  there too.
- **Keep the editor tab visible.** Browsers pause rendering in hidden tabs, so the agent's screenshots
  fail until the tab is back in front.

See `applications/mcp/README.md` for the tool list, the security model and the known limits.
