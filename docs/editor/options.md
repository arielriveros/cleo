# Options

**Options mode** (the gear at the right of the mode selector) gathers every setting that is not a
node or an asset. It shows three panels over a live viewport, so a change can be judged as it lands:

| Panel | Holds | Scope |
|---|---|---|
| **Engine** | How the engine renders and runs this game | Renderer: the open scene. Runtime: the project |
| **Editor** | How the editor behaves for you | This machine, every project |
| **Project** | What belongs to this game and travels with it | The project (exported in bundles) |

Each panel has its own pages along its top. The page you were on is remembered while the editor is open.

## Engine

**Renderer** — every render setting and debug channel; see [Rendering](rendering.md). These are
saved with the *open scene*, so each scene keeps its own look.

**Performance** — the live frame-time breakdown.

**Runtime** — project-wide, applied live in the editor and shipped in the published game's config:

| Option | Default | Does |
|---|---|---|
| Gravity | (0, −9.81, 0) | World gravity, m/s². |
| Max substeps / frame | 8 | Physics advances each frame in substeps of at most 1/60 s, up to this many. Past it the substeps lengthen — the world still covers the whole frame. |
| Max frame delta | 0.1 s | The longest frame the simulation steps. A slower frame (a hitch, a tab-out) slows the game down instead of taking one huge step. |
| Master volume | 100 % | The audio mixer's master bus. |

## Editor

**Scripts**

- **Open scripts with** — *Cleo code editor* or *VSCode*. VSCode needs the desktop app, which can
  reach your files; in the browser the option is shown greyed out and scripts open in the built-in
  editor. With VSCode chosen, opening a script (double-click, ✎ on a script slot, or a new script)
  opens its file in the external editor; the first one sets up the workspace folder if there isn't one.
- **External editor** — the command the desktop app runs: `code`, `cursor`, `codium`… A program name
  on your `PATH`, no arguments.
- **Script workspace folder** — the folder the project's scripts are mirrored to, its sync status, and
  *Open*, *Disconnect*, *Rewrite from editor* and *Apply deletions*. See
  [Scripting workflow](scripting-workflow.md#editing-in-vs-code). The menu bar only shows a chip when
  the sync needs attention (paused or in error).
- **Code editor theme** — dark or light, for every code surface.

**Viewport**

- **Fly speed** and **look sensitivity** of the editor camera (multipliers).
- **Gizmo snapping** — the move, rotate and scale steps used while Ctrl is held during a gizmo drag.

## Project

**General**

- **Name** — the project's name in the projects list and the menu bar.
- **Main scene** — the scene a published game starts in.
- **Published game** — the window / tab title (empty = the project name; also the desktop installer's
  product name), the desktop window size, *start fullscreen* and *resizable window*. A web build fills
  its page, so only the title applies there.

**Input** — the action map editor; see [Input](input.md). While this page is open the viewport
previews the on-screen touch controls.
