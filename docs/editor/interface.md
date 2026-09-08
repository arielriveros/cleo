# The editor interface

The shell: a menu bar, a strip of document tabs, and a dockable workspace of panels.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Projects  Save  Save All  Import  Export  VSCode  Publish ▾          │
│              ◀ Play Pause Stop ▶       [ Scene | Landscape | UI |    │
│                                          Renderer | Input ]  ↶ ↷  ⟲  │
├──────────────────────────────────────────────────────────────────────┤
│ Main Scene ● │ Rock.model │ Stone.mat │ Player.script │ ✕            │
├───────────────┬──────────────────────────────────┬───────────────────┤
│ Scene         │                                  │ Properties        │
│ Elements      │            Viewport              │ Scripts           │
│ UI Elements   │                                  │ Physics           │
│───────────────│                                  │                   │
│ Scene tree    │                                  │                   │
├───────────────┴──────────────────────────────────┴───────────────────┤
│ Logger │ Assets                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Menu bar

**Left group**

| Control | Does |
|---|---|
| **Projects** | Opens the project browser. Shows the current project's name. |
| **Save** | Saves the active tab. The label reports state: *Saving…*, *Saved*, *Failed*. |
| **Save All (n)** | Saves every tab with unsaved changes. |
| **Import** | Imports a project `.zip`. |
| **Export** | Exports the whole project to a `.zip`. |
| **Edit in VSCode** | Mirrors scripts to a real folder. Desktop only — see [Scripting workflow](scripting-workflow.md). |
| **Publish ▾** | Web (HTML), Desktop (Electron), Desktop installer. See [Publishing](publishing.md). |

**Centre** — the **Play / Pause / Stop** transport.

**Right** — the [mode selector](modes.md), then **Undo** / **Redo** and **Reset Layout**.

## Document tabs

A browser-style strip. One fixed **scene tab** — unclosable, movable, titled with the open scene —
plus one tab per opened asset.

- Drag to reorder.
- `✕` closes.
- A `●` marks unsaved changes.
- Each tab carries its asset kind's icon.

Opening an asset both opens a tab and switches the editor into that asset's mode. Closing it
returns you to whatever the scene tab was doing.

## Keyboard shortcuts

| Shortcut | Does |
|---|---|
| **Ctrl/Cmd + S** | Save the active tab |
| **Ctrl/Cmd + Shift + S** | Save all |
| **Ctrl/Cmd + Z** | Undo |
| **Ctrl + Shift + Z** or **Ctrl + Y** | Redo |

Save is captured before anything else sees it, so it works while you are typing in the code editor.
Undo is *not*, so text fields and the code editor keep their own undo history — which is what you
want when you are editing a script.

Tilemap mode adds **X** / **Y** / **Z** for flip and rotate; see [Tilemaps](tilemap-2d.md).

## The dockable workspace

Panels are dockview panels: drag a tab to move a panel, drop it on an edge to split, stack panels
into one group.

**The viewport is anchored.** Its group is locked and headerless, and it is never a drop target —
you cannot accidentally bury it under something else.

**Layouts are saved per mode.** The arrangement you build in Animation mode is remembered separately
from the one in Scene mode. Play mode is never persisted, so hiding everything to play does not
disturb your layout.

**Reset Layout** clears every stored arrangement and rebuilds the default.

### The default layout

| Region | Contents |
|---|---|
| Centre | **Viewport** (locked) |
| Left rail (20%) | *Scene Elements* and *UI Elements* palettes stacked above the *Scene* tree |
| Right rail (25%) | *Properties*, *Scripts*, *Physics*, plus any mode-specific panels |
| Bottom strip (30%) | *Logger*, *Assets*, and in animation-field mode the *Blend Space* plot |

### Every panel

| Panel | What it is |
|---|---|
| **Viewport** | The 3D or 2D view, plus every overlay and full-panel editor. |
| **Scene** | The node hierarchy. Becomes **Skeleton** in animation mode. |
| **Scene Elements** | The Add catalog for scene nodes. |
| **UI Elements** | The Add catalog for UI nodes (shown in UI mode). |
| **Properties** | The node inspector. Retitled per mode: *Material*, *Terrain Material*, *Tileset*, *Texture*, *Sound*, *Brain*. |
| **Scripts** | Script slot and per-node script variables. |
| **Physics** | Rigid body, trigger, shapes, ragdoll. |
| **Logger** | The console. |
| **Assets** | The asset explorer. |
| **Clips** | Animation clips (animation mode). |
| **Variables** | Animation parameters and events (animation mode). |
| **State Machine** | The selected state or transition (animation mode). |
| **Field Settings** | Blend-space axes and samples (animation-field mode). |
| **Blend Space** | The blend-space plot and its transport. |
| **Tiles** | The tile palette (tilemap mode). |
| **Layers** | The tilemap layer stack. |
| **Performance** | The frame-cost HUD (renderer mode). |
| **Renderer Settings** | Every render setting (renderer mode). |
| **Input** | Action maps and bindings (input mode). |

Which panels appear in which mode is in [Editor modes](modes.md).

## The console

Level chips filter the stream: **Logs** (log and debug), **Info**, **Warnings**, **Errors**. There
is a text filter, it sticks to the bottom as new entries arrive, and the buffer is capped.

Messages carry a category. Script output uses `'Script'`:

```ts
Logger.warn('no GameManager found', 'Script')
```

**Check the console first** when something is not working. The engine warns about the setups that
otherwise fail silently — a character with no rigid body, a locked movement axis, a missing camera
pivot, a state machine that is ping-ponging between two states.

`Logger.debug` also raises a short-lived toast in the bottom-left of the viewport, for things you
want to see without watching the console.

## Progress and notifications

Long operations — importing, publishing, exporting, saving, refreshing thumbnails — report into a
single floating progress window as a stack of step cards (running, paused, done, failed). An import
that is waiting on you shows as **paused**, which is how you tell "stalled on a decision" from
"still working". Shorter notices appear as toasts.

## Play mode

**Play** switches to the scene tab and runs a live copy of the scene. **Pause** freezes it. **Stop**
throws the copy away and returns you to the tab you pressed Play from.

While playing, all chrome panels are hidden — viewport only — and tabs, mode switching and Reset
Layout are disabled. The debug overlay menu stays available, so you can flip runtime overlays on
mid-game.

Changes made while playing are **not kept**.

## See also

[Editor modes](modes.md) · [Scene authoring](scene-authoring.md) · [Assets](assets.md)
