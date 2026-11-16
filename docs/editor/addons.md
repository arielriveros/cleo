# Addons

Addons extend the editor, and Project ▸ Addons turns them on or off for this project. An addon brings a panel, a top-bar button
or a background service. Like Godot's editor plugins, the choice is the project's: it is
saved in its Project Settings and travels with its bundle, so one project can have an addon on and another
off.

An addon that is off is not loaded at all: none of its code runs and none of its panels appear. Turning one
on or off applies at once.

Some addons need another one. Such an addon runs only while the one it needs is on: until then its switch
is greyed, with a note naming what it needs. Turning off an addon that others need turns them off too, after
asking.

## Built-in addons

- **MCP server** — the Cleo MCP server and the agent link, through which an AI agent reads and edits the
  open project: Claude Code in the editor, in a terminal or in an IDE, or Claude Desktop. While it is on, the
  **Agent** chip in the menu bar shows the link. Turning it off closes the link, so no agent can reach the
  project. See [AI agent link](ai-agent-link.md).
- **Claude Code** — a Claude Code terminal beside the editor, working on the open project through the MCP
  server. It needs the **MCP server** addon. Turning it off ends its running session; the agent link stays
  up for other agents.

A project made before addons existed has both on, and so does a project whose Claude Code was on before the
MCP server became an addon of its own. A new project chooses in the new-project dialog; both start on there.

Addons come with the editor for now. The addon contract (`features/addons/types.ts` in the editor) is what
an addon from elsewhere would implement.
