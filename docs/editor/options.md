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
| **Physics backend** | Jolt | The physics engine the game simulates with: *Jolt*, *Rapier* or *cannon-es*. Project-wide rather than per machine, because two engines do not simulate alike: the game must play the same everywhere. Read when the engine starts, so a change applies when the project is opened again. A Rapier game's published player is about 8.7 MB larger, a Jolt game's about 7.5 MB. `?physicsBackend=` in the URL asks for another one for a comparison. A project made before Jolt was the default reads as Jolt unless it was set to Rapier. One that cannot load here falls back to cannon-es, with the reason in the log. See [Physics backends](../reference/physics-backends.md). |
| **Physics thread** | Worker | Where the physics step runs. *Worker* steps it in a Web Worker while the frame renders, taking the solver off the main thread; bodies are drawn interpolated to each frame's time (see [Physics threading](../reference/physics-threading.md)). A device that cannot run the worker (no Web Workers, a single CPU core, a worker that fails to start) steps on the main thread instead. *Main thread* steps it inside the frame. *Auto* starts on the main thread and moves to the worker once physics costs 1.5 ms a frame or 40 moving bodies, and back for a while if the worker stays behind. `?physicsWorker=off` in the URL (or `localStorage.cleo_physics_worker`, which the switch under Performance ▸ Workers sets) overrides it on one machine. |
| **Simulation range** | 0 | Dynamic bodies farther than this from the camera, in metres, are frozen in place: still solid to rays, the camera and other bodies, but not simulated until the camera comes back. 0 simulates everything. A body can opt out (*Always*) or set its own range on its Collider. |

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

**Debugging**

Which debugger stops a game playing in a window (desktop app). See [Debugging scripts](debugging.md).

- **Debug scripts with** — *Cleo* (breakpoints in the script editor, the Debugger panel) or *VS Code* (VS Code
  attaches to the game window). One at a time: a game window takes one debugger.
- **VS Code debug port** — the local port VS Code attaches to (9339), and whether VS Code is attached.
  **Copy launch configuration** copies "Attach to the Cleo game" for a workspace that already has its own
  launch.json.

**Code editor**

How the built-in code editor looks.

- **Theme** — dark or light, for every code surface.

### Viewport

How the editor camera moves, how gizmos snap and how Play lets the mouse go.

**Editor camera**

How fast the editor camera responds, as multipliers on its normal speeds.

- **Fly speed** — how fast it flies, pans and lifts (WASD/QE, right-drag).
- **Look sensitivity** — how fast it turns with the mouse.

**Gizmo snapping**

The move, rotate and scale steps a gizmo drag snaps to while Ctrl is held.

- **Move step** / **Rotate step** / **Scale step** — in metres, degrees and scale units: 1 m, 15°
  and 0.1 by default.

**Play**

The game's hold on the mouse and keyboard in Play, in the viewport and in a Play window.

- **Release mouse** — the key that lets the mouse go while the game has it, Esc by default. Pick it
  from the list, or press the target icon and then the key. Outside fullscreen the browser also lets
  the mouse go on Esc. In fullscreen Play (the icon at the viewport's top right, in the browser) the game
  holds every key, browser shortcuts such as Ctrl+W included, so this key alone lets the mouse go, and
  holding Esc leaves fullscreen. Outside fullscreen the browser keeps Ctrl+W, Ctrl+T and Ctrl+N, so the
  editor asks before the tab closes while a game plays.

## Project

What belongs to this game and travels with it in a project bundle: its name, the scene it starts in,
how a published build presents itself, online play, and the input map.

### General

The project's name and main scene, and how a published build presents itself.

- **Name** — the project's name in the projects list and on the menu bar's logo button.
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
  shorter first launch, and a smaller game: of each shader's variants it ships only those. Anything missed
  still runs when first needed, drawn by the shader's general version (a parallax material then draws
  flat).
- **WebGL 2 fallback** — ship the WebGL 2 versions of the shaders too, so the game also runs where WebGPU
  does not. Off makes a WebGPU-only game, lighter by its GLSL shaders, which tells a player whose browser
  or graphics card has no WebGPU that it needs it.

**Saves**

How the game's saves are kept (see [Saving and loading](../scripting/save-game.md)). Every build of the
game must agree on these, or a player's saves would vanish with an update.

- **Save version** — the game's own save version, written into every save. Raise it when what the game
  saves changes shape; `SaveGame.onMigrate` then upgrades older saves as they load. 0 by default.
- **Save folder** — where a published game keeps its saves: `<app data>/<folder>/saves` on the desktop
  (`%APPDATA%` on Windows), the storage namespace on the web. Empty = the title, or the project name.
  Set it before the first release and keep it: renaming it loses the saves players already have.

### NetSync

Online play: the game runs on a dedicated host its players join (see [NetSync](../design/netsync.md)).
The host reads these from the published game; its own flags and environment variables win.

- **Online play** — publish the game for online play: its NetSync settings go into the build, and its web page
  asks the allocator for a host to join. Off, the game is played alone, as always.
- **Tick rate** — the host's simulation steps per second. 30 suits most games; every step is sent to every
  player, so more costs bandwidth.
- **Players per session** — how many players one session (one host) takes. 16 at most is what NetSync is
  measured for.
- **Player template** — the template each joining player gets a copy of, once the level's own player
  characters are taken. None: only those.
- **Spawn point** — where those copies appear, spread out by player.
- **Trust** — how far the host trusts what players say: carried props' positions and claimed hits. Co-op
  checks loosely; Versus checks tightly and refuses claims it cannot confirm.
- **Allocator** — the address of the game's allocator (`cleo-allocator`): the published page asks it for a host
  to join. Empty: the page joins only a host named in its address (`?join=…`).
- **Game mode** — the mode the page asks the allocator for, when its address names none (`?mode=`).

### Input

The action map editor; see [Input](input.md). While this page is open the viewport previews the
on-screen touch controls.
