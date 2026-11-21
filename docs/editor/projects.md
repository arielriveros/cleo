# Projects

A **project** is one game: its scenes, all its asset libraries, its input map, its render settings
and its editor preferences. Projects are completely isolated from one another — storage, libraries
and even dock layouts are namespaced per project.

## The launcher and the browser

On a fresh install, or when no project can be opened, you get a full-screen **launcher** to create or
pick a project. It shows the engine version.

**Projects** — the Cleo logo at the left end of the menu bar opens the same browser over the editor, with the open
project named beside its title. Each project has its own scenes, assets, scripts and layout; nothing
is shared between them.

Both have two tabs, **My Projects** and **Examples** — the second only when this build carries
examples:

- **My Projects** — the project explorer, a file manager over your projects: create an empty
  project, open one (double-click), or delete one (from the toolbar, the context menu or the Delete
  key).
- The **Examples** tab is described [below](#examples).

> **Opening another project does not reload the editor.** The window and the graphics device stay, and so do
> the compiled shaders, so the next project opens without the startup's device and shader steps. What the open
> project holds in memory is closed first: Play stops, edits waiting to be stored are stored, and its textures,
> sounds and scenes are let go. Opening a new project, installing an example and importing a bundle go the same
> way.
>
> **Deleting the open project** closes it, deletes it, and opens the project you used most recently, or a new
> empty one if it was the last. The one dialog that asks about deleting also lists unsaved edits that would be
> lost. **Deleting a project takes its dock layouts, sounds, GI bakes and Play saves with it.**
>
> In the desktop app projects are [folders](project-folders.md): **My Projects** lists the folders you have
> opened, with **Open Folder…** and **Import .zip…**, and **Remove** takes a project off the list (its cache with
> it) while its folder stays where it is.

## Examples

The **Examples** tab lists example projects with a thumbnail, a description, a size and a scene
count. Opening one adds it as a **new project** (in the desktop app, a new project folder where you choose) —
your existing projects are untouched. Anything over 25 MB asks first.

In the engine's repository each example is a project folder, `examples/<slug>/`, with its own tests; the gallery
is built from those folders (see `examples/README.md` in the repository).

Examples are the fastest way to see a working setup. These are documented in depth:

- [Sandbox](sandbox-example.md), locomotion in the style of Advanced Locomotion System v4
- [Third-person strafe character](../scripting/third-person-character.md)
- [Dungeon](../../examples/dungeon/docs/SOULS_DEMO.md), the souls-like example game

## Scenes

A project holds many scenes. One is the **main scene**, set in
[Scene settings](scene-authoring.md#scene-settings) — that is where a published game starts.

Scripts move between them with `Game.loadScene(name)`, so a main menu, a level and an end screen are
three scenes and two calls.

## Export

**Project ▸ Export Project** writes the whole project to a single `.zip`: every scene, all libraries, the folder
layout, preferences and every texture and audio payload. It is assembled off the main thread, so the
editor stays responsive.

This is your backup, your way to move a project between machines, and your way to hand it to someone
else.

## Import

**Project ▸ Import Project…** reads a project `.zip` and offers three outcomes:

| Outcome | Effect |
|---|---|
| **New project** | Adds it alongside what you have. The safe default. |
| **Replace** | Overwrites the current project. |
| **Merge** | Folds it into the current project, re-minting colliding ids and remapping the references that point at them. |

New-project and Merge confirm unsaved work first. A successful import opens the project it went into, in
place: Replace and Merge close the current project, write the bundle into it, and open it again.

Merge is what you want for combining an asset pack into an existing game. It is also the usual way
to acquire the orphan entries the [asset audit](assets.md#missing-assets) reports, so it is worth
running the audit afterwards.

> Bundles are **format 2**, which packs every bulk payload into one binary. **Format 1 is still
> readable**, so old exports and older shipped examples still import. See
> [File formats](../reference/file-formats.md#project-bundle--zip).

## Saving

**Ctrl+S** saves the active tab; **Ctrl+Shift+S** saves all. Unsaved tabs carry a `●`, and the
Save All button shows how many there are.

Closing the editor with unsaved work warns first, as does switching project or importing over the
top of one.

**Unsaved changes** — asked before closing a tab or switching scenes would drop edits. **Save** writes
them and carries on, **Discard** drops them and carries on, **Cancel** stays where you are.

## Storage

In the desktop app a project is a folder on disk, and the app's own storage is only a cache of it: see
[Project folders](project-folders.md). In the browser everything lives in the browser's storage, namespaced by
project; to get things out, Export.

## See also

[Assets](assets.md) · [Publishing](publishing.md) · [File formats](../reference/file-formats.md)
