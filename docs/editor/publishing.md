# Publishing

**Publish ▾** in the top bar turns the project into a playable build.

## Targets

| Target | Produces | Available |
|---|---|---|
| **Web (HTML)** | `index.html`, `game.js` and `game.bin` | Everywhere. In the desktop app it writes to a folder you choose; in the browser it downloads a `.zip`. |
| **Desktop (Electron)** | A runnable game folder | Desktop app only. |
| **Desktop installer** | A native installer | Desktop app only. |

## What happens

Two reported phases:

1. **Serializing scene** — the open scene is taken from the **live** editor, so unsaved edits are
   included, and every other scene is re-resolved against the current libraries. Textures are
   embedded once and shared.
2. **Building and writing files** — scripts are extracted and obfuscated, assets are packed, and the
   output is written or zipped.

The project's current render settings and its input map are written into the build.

## What ships, and what does not

| Kept | Dropped |
|---|---|
| Every scene, with the **main scene** as the entry point | Editor-only nodes: the grid, gizmos, light icons, collision wireframes, the navmesh preview |
| Textures that something references | Textures nothing references |
| Audio sources and sound samples, with their loop points, fades, buses and effects | The AI brain library — brains are embedded on their controllers |
| Terrain data, DEFLATE-compressed | The authoring data for the **unused dimension** |
| Scripts, obfuscated | |

Editor-only nodes are **structurally absent**, not merely hidden — there is no flag left to turn
back on.

> **The unused dimension is discarded.** A 2D build drops 3D authoring data and a 3D build drops the
> 2D data. That is also why changing a scene's dimension warns first: the loss is real.

## The main scene

A build starts in the project's main scene, set in
[Scene settings](scene-authoring.md#scene-settings). Scripts move between scenes with
`Game.loadScene(name)`.

A common shape is three scenes: a menu, the game, and an end screen — with a two-line button script
in each.

## The player contract

A published game carries a **contract number** saying what the packer emitted, and the player checks
it in two directions: publishing refuses when the built player is stale, and a player refuses to
boot a game newer than itself.

It exists because ignoring an unknown field degrades **silently** — flat terrain, a missing HUD,
characters stuck in bind pose. A loud refusal is better than a game that looks broken for no
apparent reason.

Practical consequence: after upgrading the engine across a contract bump, **republish**. The history
is in [File formats](../reference/file-formats.md#player-contract).

## Testing a build

Play mode is a faithful preview of most things, but a few differences only show up in a real build:

| Check | Why |
|---|---|
| Scene transitions | Play mode starts in the scene you have open, not the main scene. |
| Every scene loads | A scene you have not opened recently may reference something you deleted. |
| Textures are present | Only *referenced* textures ship. Anything reached by a name built at runtime will be missing. |
| Terrain and foliage | The dimension strip and compression happen only at publish. |
| The HUD at other resolutions | Resize the window; the UI should scale, not drift. |
| Audio | Sound is silenced while authoring, so a build is the first place you hear the mix. |

The first two are the ones that actually catch bugs.

## Sharing

A web build is a folder of static files — any static host will serve it. The desktop targets produce
a runnable app and an installer respectively.

## See also

[Projects](projects.md) · [File formats](../reference/file-formats.md) · [Scene and game (scripting)](../scripting/scene-and-game.md)
