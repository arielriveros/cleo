# AI agent link (MCP)

*Unreleased, proof of concept: dev builds of the editor only.*

An AI agent such as Claude Code or Claude Desktop can work in the editor alongside you. It can:

- build scenes, add nodes and change their properties
- write scripts and attach them to nodes
- make materials
- take screenshots of the viewport
- play the game and read its console

**Claude** at the right end of the menu bar opens the Claude panel at the right edge of the editor: your own
Claude Code, running in a terminal inside the panel. It signs in with your Claude account, so it runs on
your Claude plan with no extra charge.

An **external agent** works too, such as Claude Code in a terminal or VS Code, or Claude Desktop, connected
through the **Cleo MCP server** (`applications/mcp`).

All of them go through the **Cleo agent host**, a small background program that holds the editor's link.
It carries out each request on the project you have open, and it lets everything share one editor.

The panel stays open in every mode and during Play. Drag its left edge to resize it.

## Setting it up

1. Install the agent package once: `cd applications/mcp && npm install`.
2. Start the editor (`npm run editor:dev`) and open a project.

That is enough for the panel: opening it starts the agent host. The panel also needs Claude Code installed
on this machine (`claude` on the PATH); see the Claude Code setup guide at
https://code.claude.com/docs/en/setup.

For an external agent, also register the MCP server with it. For Claude Code:
`claude mcp add cleo -- node <engine>/applications/mcp/src/index.mjs`.

## Claude Code in the editor

The Claude panel runs the `claude` program installed on this machine, unchanged, in a terminal. It is the
same Claude Code you would run in a terminal yourself, with the Cleo tools already connected.

- **Signing in.** Claude Code signs in on its own, through Anthropic: the first time, it opens your browser
  to log in. Type `/login` to sign in or switch accounts, and `/status` to see which account it uses. Cleo
  never sees your login.
- **Cost.** With a Claude subscription, it counts toward your plan's usage limits. Nothing extra is billed.
  (If `ANTHROPIC_API_KEY` is set where the editor started, Claude Code asks whether to use that key
  instead.)
- **First start.** It starts in the engine folder and asks once whether you trust that folder.
- **Using it.** Type to Claude as in any terminal. Its changes to the project show up in the viewport as
  they happen, and each request is one undo step. The Cleo tools run without asking each time (Ctrl+Z
  undoes any of it); running its own JavaScript in the editor still asks every time.
- **This, here.** Claude can work on whatever you have selected: *"make this spin"* means the selected
  node. It can also show you what it did: it takes screenshots of the viewport as part of its changes.
- **It knows the engine.** Before writing a script, Claude looks up the engine API it needs (classes,
  methods, their documentation) straight from the engine, so its scripts use what the engine really has.
- **Copy and paste.** Select text and press Ctrl+C to copy it; without a selection, Ctrl+C is Claude Code's
  own interrupt. Ctrl+V pastes. Every other key, such as Esc, goes to Claude Code.
- **It keeps running.** Closing the panel, switching tabs or reloading the editor leaves the session
  running: the screen comes back as it was. It stops 15 minutes after the last editor window closes.
- **New session** (+ in the header) ends the running session and starts a fresh one. When Claude Code
  exits, **New session** and **Continue last** (its most recent conversation) start it again.

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
