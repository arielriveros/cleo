# AI agent link (MCP)

*Unreleased, proof of concept: dev builds of the editor only.*

An AI agent such as Claude Code or Claude Desktop can work in the editor alongside you. It can:

- build scenes, add nodes and change their properties
- write scripts and attach them to nodes
- make materials
- take screenshots of the viewport
- play the game and read its console

The agent talks to the **Cleo MCP server** (`applications/mcp`). That server relays the agent's requests
to the editor you have open, and the editor carries them out on the project you are working on.

## Setting it up

1. Install the server once: `cd applications/mcp && npm install`.
2. Register it with your agent. For Claude Code:
   `claude mcp add cleo -- node <engine>/applications/mcp/src/index.mjs`.
3. Start the editor (`npm run editor:dev`) and open a project.

When the agent starts, its server appears and the editor links to it within a few seconds.

## The Agent chip

**Agent** sits in the menu bar while a Cleo MCP server is running on this machine. Its dot shows the state
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
