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

**Project folder**

The open project's [folder](project-folders.md) (desktop app), where its scripts are the `.ts` files under
`Assets/`, with *Open in VS Code* and *Show folder*. A script saved in another editor is taken in at once. See
[Scripting workflow](scripting-workflow.md#editing-in-vs-code).

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

What belongs to this game and travels with it in a project bundle: its name, its saves, its published game,
online play, the input map and the names of its collision layers.

### General

The project's name and main scene, and how its saves are kept.

- **Name** — the project's name in the projects list and on the menu bar's logo button.
- **Main scene** — the scene a published game starts in (the **Start scene** of the Published game page). Scenes
  load each other from scripts after that.

**Saves**

How the game's saves are kept (see [Saving and loading](../scripting/save-game.md)). Every build of the
game must agree on these, or a player's saves would vanish with an update.

- **Save version** — the game's own save version, written into every save. Raise it when what the game
  saves changes shape; `SaveGame.onMigrate` then upgrades older saves as they load. 0 by default.
- **Save folder** — where a published game keeps its saves: `<app data>/<folder>/saves` on the desktop
  (`%APPDATA%` on Windows), the storage namespace on the web. Empty = the title, or the project name.
  Set it before the first release and keep it: renaming it loses the saves players already have.

### Published game

Everything a publish (Project ▸ Publish: web, desktop or desktop installer) makes the game from that is not
its content: the scene it starts in and the scenes it carries, what it runs on, and how it presents itself.
**Reset publish options** sets the page back to its defaults (the start scene and the physics backend are
the project's own settings and stay).

**Start**

Where the game starts, and which of the project's scenes it carries.

- **Start scene** — the scene the game starts in: the project's main scene, the same setting as General's.
- **Scenes** — the scenes the published game carries, one switch each. A new scene ships until it is switched
  off; the start scene always ships. A scene left out takes the textures, sounds and lighting bakes only it
  used with it, so the game is smaller, and a script's `Game.loadScene` does not find it.

**Rendering and physics**

What the game runs on, whoever plays it: the same on the web and on the desktop.

- **Graphics API** — what the game draws with. *Same as the editor* is the one this editor is set to run on
  (Options ▸ Engine ▸ Renderer ▸ Graphics API, a setting of this machine), read when you publish; *WebGPU* or
  *WebGL 2* fixes it for the project, whoever publishes. A game asked to run on WebGPU where there is none runs on
  WebGL 2 if it carries the WebGL 2 shaders (below), and says it needs WebGPU if not. The game writes what it runs
  on to the browser console as it starts, with the reason when it is not what it was asked for.
- **WebGL 2 fallback** — ship the WebGL 2 versions of the shaders too, so a WebGPU game also runs where WebGPU
  does not. Off makes a WebGPU-only game, lighter by its GLSL shaders, which tells a player whose browser or
  graphics card has no WebGPU that it needs it. Always on for a WebGL 2 game.
- **Only used shaders** — compile just the shaders this game uses at startup, not all of them: a much
  shorter first launch, and a smaller game: of each shader's variants it ships only those. Anything missed
  still runs when first needed, drawn by the shader's general version (a parallax material then draws
  flat).
- **Physics backend** — the physics engine the game simulates with: the project's, the same setting as Options ▸
  Engine ▸ Runtime. The editor reads it when the project opens; a publish always uses it. A backend that cannot
  load where the game runs falls back to cannon-es, said in the console.

**Window and identity**

How the published build presents itself. The window size and flags apply to the desktop build; a web
build fills the page it is embedded in, so only the title applies there.

- **Title** — the window or browser-tab title, the desktop installer's product name and the folder a
  publish saves into. Empty = the project name.
- **Version** — the game's own version, as three numbers (`1.2.0`, or `1.2.0-beta.1` before a release): its
  installer's and its package's, and written into `game.bin`. Raise it for every release, since an update is a
  higher version. 1.0.0 by default. It is not the save version below.
- **App id** — the game's application id, reverse-DNS (`com.studio.game`): what Windows installs it under and
  groups its taskbar button by, and what a newer installer must share to install over the old one. A new project
  gets one of its own; an older one keeps the id its installers were always given (`com.cleo.game.` and its
  name), written here at its next publish. Set it before the first release and keep it: changing it makes the
  next installer a different app. See [Game updates](../design/game-updates.md).
- **Icon** — the image the game's icon is made from: the desktop window's, the executable's and the installer's,
  and the web page's favicon. Pick a square one of 512 pixels or more; another shape is fitted inside a square
  with clear sides, and a small one comes out soft. None = Cleo's icon.
- **Cover** — the project's picture: the card the project browser shows for it, instead of its main scene's
  thumbnail. Pick an image, or press the camera to capture the view being edited (the focused pane of a split
  viewport) at 1920×1080 and full detail, without the grid, gizmos, collider wireframes, icons or the selection
  outline. A capture is an image in Assets ▸ Publishing; capturing again replaces it.
- **Window size** — the desktop window's size at launch, in pixels.
- **Start fullscreen** / **Resizable window** — how the desktop window opens, and whether the player
  may resize it.

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

### Layers

The names of the project's [collision layers](physics.md#layers).

**Collision layers** — the names of its 16 layers, one table for its 3D and its 2D physics alike. They are what every layer picker shows: a Collider's, a Trigger's or a 2D body's **Layer** and **Collides
with**, a camera rig's **Blocked by** and **See through**, foot placement's **Trace layers**, and what a 2D AI
**Sees**. They are also what scripts find layers by: `physics.layer('Enemies')`, or `physics2D.layer('Enemies')`
in a 2D scene.

- The first four are the engine's and cannot be renamed: **Default** (tilemaps and everything that does not
  say otherwise), **Ragdoll**, **See Through** and **No Camera**.
- An unnamed layer shows as *Layer N*.
- Renaming a layer changes no body: bodies store the layer, not its name.
