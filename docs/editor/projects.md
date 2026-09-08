# Projects

A **project** is one game: its scenes, all its asset libraries, its input map, its render settings
and its editor preferences. Projects are completely isolated from one another — storage, libraries
and even dock layouts are namespaced per project.

## The launcher and the browser

On a fresh install you get a full-screen **launcher** to create or pick a project. It shows the
engine version.

Once a project is open, **Projects** in the top bar opens the browser, which has two tabs: **My
Projects** and **Examples**.

The project explorer is a file manager over your projects: create an empty project, open one, or
delete one (from the toolbar or the context menu).

> **Switching projects reloads the editor**, because every storage key is namespaced and the whole
> library set changes. **Deleting a project takes its dock layouts with it.**

## Examples

The **Examples** tab lists example projects with a thumbnail, a description, a size and a scene
count. Opening one downloads it and adds it as a **new project** — your existing projects are
untouched. Anything over 25 MB asks first.

Examples are the fastest way to see a working setup. Two are documented in depth:

- [Third-person strafe character](../../examples/scripts/README.md)
- [Night Shift](../../examples/scripts/NIGHT_SHIFT.md), a complete small game

## Scenes

A project holds many scenes. One is the **main scene**, set in
[Scene settings](scene-authoring.md#scene-settings) — that is where a published game starts.

Scripts move between them with `Game.loadScene(name)`, so a main menu, a level and an end screen are
three scenes and two calls.

## Export

**Export** writes the whole project to a single `.zip`: every scene, all libraries, the folder
layout, preferences and every texture and audio payload. It is assembled off the main thread, so the
editor stays responsive.

This is your backup, your way to move a project between machines, and your way to hand it to someone
else.

## Import

**Import** reads a project `.zip` and offers three outcomes:

| Outcome | Effect |
|---|---|
| **New project** | Adds it alongside what you have. The safe default. |
| **Replace** | Overwrites the current project. |
| **Merge** | Folds it into the current project, re-minting colliding ids and remapping the references that point at them. |

New-project and Merge confirm unsaved work first, and a successful import reloads the editor.

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

## Storage

Everything lives in the browser's (or the desktop app's) own storage, namespaced by project — not as
files on disk. To get things out, Export. To work on scripts as real files, use the
[VS Code workspace](scripting-workflow.md#editing-in-vs-code).

## See also

[Assets](assets.md) · [Publishing](publishing.md) · [File formats](../reference/file-formats.md)
