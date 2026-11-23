# AI agent link (MCP)

*Unreleased, proof of concept: dev builds of the editor only.*

An AI agent such as Claude Code or Claude Desktop can work in the editor alongside you. It can:

- build scenes, add nodes and change their properties
- make templates (prefabs) and variants, and place them
- write scripts and attach them to nodes
- make materials: PBR, cel, foliage or unlit, with textures from the project
- open and create scenes, and open assets in their tabs
- take screenshots of the viewport, from up to four angles at once
- play the game, press its keys, and read back how things moved and what the console said

Two addons make this up ([Addons](addons.md)), each turned on or off for the project in Project ▸ Addons:

- **MCP server**: the agent link, and the **Agent** chip that shows it. With it off, no agent reaches the
  project, in the editor or outside it, and there is no chip.
- **Claude Code**: the **Claude** button and the Claude panel. It needs the MCP server: with that off,
  Claude Code is off too and its switch is greyed.

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

That is enough: with the MCP server addon on, the editor starts the agent host as it opens the project. The panel also needs Claude Code installed
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
  they happen, and each request is one undo step. The Cleo tools run without asking each time, its own
  JavaScript in the editor included (Ctrl+Z undoes any of it; the Agent chip can turn the JavaScript off).
- **This, here.** Claude can work on whatever you have selected: *"make this spin"* means the selected
  node. It can also show you what it did: it takes screenshots of the viewport as part of its changes.
- **It knows the engine.** Before writing a script, Claude looks up the engine API it needs (classes,
  methods, their documentation) straight from the engine, so its scripts use what the engine really has.
- **New lines.** Enter sends what you typed. Shift+Enter or Shift+Space starts a new line instead, as in a
  chat box.
- **Copy and paste.** Select text and press Ctrl+C to copy it; without a selection, Ctrl+C is Claude Code's
  own interrupt. Ctrl+V pastes. Every other key, such as Esc, goes to Claude Code.
- **It keeps running.** Closing the panel, switching tabs, reloading the editor or opening another project
  leaves the session running: the screen comes back as it was, and Claude can go on working while the panel
  is closed. (A project with the Claude Code addon off stops it.) It stops 15 minutes after the last editor
  window closes.
- **It carries on.** When the agent host itself starts again (the editor's dev server was restarted, or the
  computer), the panel picks its conversation back up instead of starting a blank one. Only a turn that was
  under way is lost.
- **The header** names the conversation, once Claude Code has given it a title, and its dot is green while
  Claude Code runs. Hover over the title for the version and where it started. **New session** (+) ends the
  running session and starts a fresh one; **Stop** ends it and keeps the conversation. When Claude Code
  exits, **New session** and **Continue last** (the conversation the panel was on) start it again.
- **Earlier conversations.** Click the title for the conversations Claude Code saved for the folder it runs
  in, the most recent first, with a search box. Each one shows where it was started (this panel, a
  terminal, VS Code) and when it was last used. Pick one to carry on with it: the running session ends, its
  own conversation stays saved, and Claude Code starts again on the one you picked. A conversation open in
  another Claude Code right now is greyed: close it there first.
- **Text size.** Ctrl+wheel over the terminal makes its text bigger or smaller; the panel remembers it.

## The Agent chip

The editor links to agents while the **MCP server** addon is on, whether or not the Claude panel is open:
it starts the agent host when the project opens, and starts it again if it stops. Claude Code running in a
terminal or an IDE with the Cleo MCP server reaches the editor the same way. With the addon off, the editor
makes no call to the agent host at all.

**Agent** sits in the menu bar whenever the MCP server addon is on, and you can always click it. Its dot
shows the state of the link:

| State | Meaning |
|---|---|
| Green dot | Linked. The agent's commands run in this editor. The dot pulses while one is running. |
| **Agent…** | Starting the agent host, or linking to it. |
| **Agent off** | You disconnected: click the chip, then **Connect**. With a red dot, the agent host could not start: the chip's menu says why and has **Retry**. A build without the dev server has no agent host. |
| **Agent (other tab)** | Another editor tab holds the link. Click the chip, then **Use this tab**. |
| **Agent refused** | The server did not accept this editor, usually because the server was restarted. Click the chip, then **Connect**. |

The chip's menu shows how many commands have run and the last one. It also has two controls:

- **Allow code execution** lets the agent run its own JavaScript inside the editor, for jobs no other tool
  covers. Turn it off to refuse those requests. Claude Code does not ask before each run: this switch is
  the control.
- **Disconnect** stops the link until you connect again.

## What to expect

- **Edits land on your undo stack.** Each request the agent makes is one step, labelled with what it did,
  so Ctrl+Z reverts the whole request, including the scripts, materials and templates it made or changed.
  A request that fails part-way changes nothing at all. Opening another scene starts that scene's undo
  history fresh, as it does for you; a new scene stays in the project.
- **Nothing is saved until someone saves.** The agent's edits mark the tab unsaved like yours do. The
  agent saves only when asked.
- **Play stays separate.** While the game runs, the agent can watch it, capture it, read its logs and
  press keys and mouse buttons in it (a test of a player controller), but it cannot edit the scene. Stop
  discards anything changed during play, as it does for you. The agent always plays in the editor: a game
  you started in its own window (Play target **Window**) it can only stop or pause.
- **Mouse look under pointer lock cannot be pressed for.** A browser grants pointer lock only to a real
  click, so an agent tests looking around through a drag binding (a mouse button held while moving).
- **Preview tabs are not edited.** In a material, animation, script or other asset tab, the agent's scene
  edits are refused: it switches back to the scene tab, or opens a template or model in its own tab.
- **Screenshots can move the editor camera.** When the agent frames a node to look at it, your view moves
  there too. A sheet of four angles puts the camera back afterwards. In a split viewport, a screenshot shows
  the editing pane.
- **Keep the editor tab visible.** Browsers pause rendering in hidden tabs, so the agent's screenshots
  fail until the tab is back in front.

See `applications/mcp/README.md` for the tool list, the security model and the known limits.
