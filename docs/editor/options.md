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

### Renderer

Every render setting and debug channel; see [Rendering](rendering.md). These are saved with the
*open scene*, so each scene keeps its own look.

### Performance

The live frame-time breakdown: what the frame costs, and where. See
[Performance HUD](rendering.md#performance-hud).

### Runtime

How every scene runs, project-wide: applied live in the editor's Play and shipped in the published
game's config.

**Physics**

How the physics world steps, and how much of it.

| Option | Default | Does |
|---|---|---|
| **Gravity** | (0, −9.81, 0) | World gravity, m/s². Earth is (0, −9.81, 0); a top-down or space game often wants zero. |
| **Max substeps / frame** | 8 | Each frame advances physics in equal substeps of at most 1/60 s, up to this many. Past it the substeps grow longer: the world still covers the whole frame, in coarser steps. Lower is less work on slow frames, and less stable stacks and joints. |
| **Simulation range** | 0 | Dynamic bodies farther than this from the camera, in metres, are frozen in place: still solid to rays, the camera and other bodies, but not simulated until the camera comes back. 0 simulates everything. A body can opt out (*Always*) or set its own range in its Physics panel. |

**Frame timing**

How the simulation treats a slow frame.

| Option | Default | Does |
|---|---|---|
| **Max frame delta** | 0.1 s | The longest frame the simulation steps. A slower frame (a hitch, a breakpoint, a tab-out) slows the whole game down instead of taking one huge step: at 0.1 s, below 10 fps. |

**Audio**

The mix every sound plays through.

| Option | Default | Does |
|---|---|---|
| **Master volume** | 100 % | The audio mixer's master bus. |

## Editor

### Scripts

Where scripts open, the external editor and its workspace folder, and the code theme.

**Opening scripts**

What happens when you double-click a script, press ✎ on a script slot, or create a new one.

- **Open scripts with** — *Cleo code editor* or *VSCode*. VSCode needs the desktop app, which can
  reach your files; in the browser the option is shown greyed out and scripts open in the built-in
  editor. With VSCode chosen, opening a script opens its file in the external editor; the first one
  sets up the workspace folder if there isn't one. Edits sync back live, and the built-in editor stays
  one click away in the script's tab menu.
- **External editor** — the command the desktop app runs to open the workspace: `code` (VSCode),
  `cursor`, `codium`… A program name on your `PATH`, no arguments.

**Script workspace folder**

Every script of this project, mirrored to a real folder with typings, so an external editor gets
autocomplete; saved files sync back into the editor. The section shows the folder and its sync
status, with *Open*, *Disconnect*, and — when the sync needs attention — *Rewrite from editor* and
*Apply deletions*. Desktop app only. See [Scripting workflow](scripting-workflow.md#editing-in-vs-code).
The menu bar only shows a chip when the sync needs attention (paused or in error).

**Code editor**

How the built-in code editor looks.

- **Theme** — dark or light, for every code surface.

### Viewport

How the editor camera moves and how gizmos snap.

**Editor camera**

How fast the editor camera responds, as multipliers on its normal speeds.

- **Fly speed** — how fast it flies, pans and lifts (WASD/QE, right-drag).
- **Look sensitivity** — how fast it turns with the mouse.

**Gizmo snapping**

The move, rotate and scale steps a gizmo drag snaps to while Ctrl is held.

- **Move step** / **Rotate step** / **Scale step** — in metres, degrees and scale units: 1 m, 15°
  and 0.1 by default.

## Project

What belongs to this game and travels with it in a project bundle: its name, the scene it starts in,
how a published build presents itself, and the input map.

### General

The project's name and main scene, and how a published build presents itself.

- **Name** — the project's name in the projects list and the menu bar.
- **Main scene** — the scene a published game starts in. Scenes load each other from scripts after
  that.

**Published game**

How a published build presents itself. The window size and flags apply to the desktop build; a web
build fills the page it is embedded in, so only the title applies there.

- **Title** — the window or browser-tab title, the desktop installer's product name and the folder a
  publish saves into. Empty = the project name.
- **Window size** — the desktop window's size at launch, in pixels.
- **Start fullscreen** / **Resizable window** — how the desktop window opens, and whether the player
  may resize it.
- **Only used shaders** — compile just the shaders this game uses at startup, not all of them: a much
  shorter first launch. Anything missed still compiles when first needed.

### Input

The action map editor; see [Input](input.md). While this page is open the viewport previews the
on-screen touch controls.
