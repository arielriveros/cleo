# Addons

Addons extend the editor, and Project ▸ Addons turns them on or off for this project. An addon brings a panel, a top-bar button
or a background service. Like Godot's editor plugins, the choice is the project's: it is
saved in its Project Settings and travels with its bundle, so one project can have an addon on and another
off.

An addon that is off is not loaded at all: none of its code runs and none of its panels appear. Turning one
on or off applies at once.

## Built-in addons

- **Claude Code** — a Claude Code terminal beside the editor, with the agent link that lets Claude read and
  edit the open project. See [AI agent link](ai-agent-link.md). Turning it off ends its running session and
  closes the agent link, so an external agent (Claude Code in a terminal, Claude Desktop) cannot reach this
  project either.

A project made before addons existed has Claude Code on. A new project chooses in the new-project dialog;
Claude Code starts on there.

Addons come with the editor for now. The addon contract (`features/addons/types.ts` in the editor) is what
an addon from elsewhere would implement.
