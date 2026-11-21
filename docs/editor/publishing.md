# Publishing

**Project ▸ Publish** in the menu bar turns the project into a playable build.

## Targets

| Target | Produces | Available |
|---|---|---|
| **Web (HTML)** | `index.html`, the player's modules and `game.bin` | Everywhere. In the desktop app it writes to a folder you choose; in the browser it downloads a `.zip`. |
| **Desktop (Electron)** | A runnable game folder | Desktop app only. |
| **Desktop installer** | A native installer | Desktop app only. |

## What happens

Two reported phases:

1. **Serializing scene** — the open scene is taken from the **live** editor, so unsaved edits are
   included, and every other scene is re-resolved against the current libraries. Textures are
   embedded once and shared.
2. **Building and writing files** — scripts are extracted and obfuscated, assets are packed, and the
   output is written or zipped.

Every scene's render settings and the project's input map are written into the build. The open scene's
are taken live from the renderer, the others as last saved.

## What ships, and what does not

| Kept | Dropped |
|---|---|
| Every scene, with the **main scene** as the entry point | Editor-only nodes: the grid, gizmos, light icons, collision wireframes, the navmesh preview |
| Textures that something references | Textures nothing references |
| Audio sources and sound samples, with their loop points, fades, buses and effects | The AI brain library — brains are embedded on their controllers |
| Terrain data, DEFLATE-compressed | The authoring data for the **unused dimension** |
| Scripts, obfuscated | |
| The engine, as the player's modules the game needs | The physics backends the game does not run on |
| Every shader's general version, and the variants the game uses (with **Only used shaders**) | The other shader variants; the WebGL 2 shaders when **WebGL 2 fallback** is off |
| The features the project keeps ([Project features](project-features.md)) | The nodes, render settings and shaders of the features it leaves out; publishing asks first when the game still uses one |
| | The editor's tools: the model importers, the script compiler and the movie renderer. A script in a published game cannot import them from `cleo` |

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

A desktop game is served from its own folder over `game://app`, with the two headers that make a page
cross-origin isolated. The physics worker then hands each step back through shared memory rather than a
message, which keeps frames from waiting on it. A web build gets the same where its host sends those
headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

The build includes a `_headers` file with them, which Netlify and Cloudflare Pages read. Without them the
game runs all the same.

### How a game reads its data

A running game never holds all of `game.bin`. It reads the parts it needs when it needs them: the manifest
first, every texture and sound once, and a scene's meshes and landscape when that scene loads. What it reads
goes once the engine has it. A texture keeps its decoded picture only when a UI image shows it or it is a
colour-grading LUT.

| Where it runs | How `game.bin` is read |
|---|---|
| Desktop build | A part at a time, from the game's folder. An installer puts `game.bin` beside `app.asar`. |
| Play in window | A part at a time, from the copy the editor leaves in the browser's storage. |
| Web build, on a host that serves byte ranges | A part at a time. Most static hosts and dev servers do, `npx http-server` among them. |
| Web build, on a host that does not | Whole, once, with a percentage on the loading screen. `python -m http.server` is one. |

A script can still point a UI image at any texture: the game reads that picture again and shows it a few
frames later. Textures in a published game cannot be saved back out (`serializeTexture` returns nothing),
because the game does not keep their files.

> **Desktop builds before this one** had a `preload.js` that read the whole file into the game. A new
> publish into the same folder deletes it.

> **Desktop builds before this one** opened the game from `file://`. Anything a game kept in browser
> storage (`localStorage`, IndexedDB) belongs to that origin, so a player's data from such a build does
> not carry over to a newer one.

### Saves

What a game saves with `SaveGame` (see [Saving and loading](../scripting/save-game.md)) is kept apart from
the game itself, so an update or a reinstall keeps it:

| Build | Where saves are kept |
|---|---|
| Desktop | One file per slot, `<slot>.cleosave`, in `<app data>/<save folder>/saves`: on Windows `%APPDATA%\<save folder>\saves`, on macOS `~/Library/Application Support/<save folder>/saves`, on Linux `~/.config/<save folder>/saves`. The save it replaced is kept beside it as `<slot>.cleosave.bak`. |
| Web | The browser's storage for the site the game is served from, under the save folder's name. Clearing the site's data deletes them. |

The **save folder** is set in Options ▸ Project ▸ General ▸ Saves; empty, it is the game's title. Set
it before the first release and keep it: a game published under another one does not find its players'
saves. Saves made while playing in the editor are the project's Play saves (the [Saves panel](saves.md)),
and never ship.

The desktop game's page is still sandboxed: its one preload, `gamePreload.js`, lends it the save folder
through four calls that take slot names, never paths.

### Identity, icon and updates

What a build says about itself comes from Options ▸ Project ▸ General ▸ Published game:

| Setting | Where it goes |
|---|---|
| **Title** | The page's `<title>`, the desktop window's title and the installer's product name. |
| **Version** | The desktop game's `package.json`, so its installer's name and its `latest.yml`, and `game.bin`'s manifest. |
| **App id** | The installer, the Windows taskbar grouping, and `game.bin`'s manifest. An installer upgrades an install with the same app id. |
| **Icon** | `icon.png` (512 px) and `icon.ico` (16 to 256 px) beside the game: the web page's favicon, the desktop window's icon, and the executable's, the installer's and the uninstaller's. |

A desktop installer is written with its update files beside it: `latest.yml` (`latest-mac.yml`,
`latest-linux.yml`) and the installer's `.blockmap`. Nothing reads them yet; they are what an update of the
game will be offered from. See [Game updates](../design/game-updates.md) for the plan: full updates and content
patches on the desktop, a version check on the web, and the stores.

## See also

[Projects](projects.md) · [File formats](../reference/file-formats.md) · [Scene and game (scripting)](../scripting/scene-and-game.md) · [Game updates (plan)](../design/game-updates.md)
