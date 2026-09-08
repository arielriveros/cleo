# Scripting workflow

Creating scripts, attaching them, tuning them per node, and — if you prefer — editing them in
VS Code.

How to *write* a script is [Getting started](../scripting/getting-started.md).

## Creating a script

**Assets ▸ + Add ▸ Script**, or select a node and use the Scripts panel's **+ Create Script**.

Opening a script asset puts the editor into **Script mode**: a full-panel code editor with the
engine's complete typings loaded, so you get autocomplete and type errors against the real API.

A new script starts as a class extending `Node`. Change the base class to match the node it will sit
on — `CharacterNode`, `UIRootNode`, `ControllerNode`, and so on. The base is resolved by class name.

**Ctrl+S** saves. Save is captured before the code editor sees it, so it works while you are typing;
undo is *not*, so the code editor keeps its own history.

There is also a GLSL editing mode, for custom material shaders.

## Attaching a script

Three ways:

- Drag the script from Assets onto a node in the hierarchy.
- Select the node, open the **Scripts** panel, and pick the script.
- Drop it on a node in the viewport.

Hovering a script card in the Assets panel **highlights every node using it**, which is the quickest
answer to "what is this attached to".

One script asset can be attached to many nodes. It is shared: editing it changes all of them.

## Per-node variables

Public class fields with defaults appear in the Scripts panel as editable values on **that node**:

```ts
export default class SpawnerNode extends Node {
  public templateName: string = 'Zombie'
  public interval: number = 6
  public maxAlive: number = 14

  private _live: Node[] = []      // hidden — underscore prefix
}
```

One spawner script can drive an easy spawner and a hard one with no code duplication.

Supported types are `number`, `string`, `boolean` and `vec3`. Anything else works as private state
but does not appear.

A value edited on a node is saved with the scene and overrides the code default. Changing the
default in code affects only the nodes that have never had that field edited.

## Node variables

Separate from script fields, and used differently: variables are created at runtime or in the
Variables panel, carry a type and an **access modifier** (`public` / `protected` / `private`), and
are meant for *other* scripts to read.

The usual use is a marker:

```ts
onStart() { this.setVariable('isPlayer', true, 'boolean', 'public') }
```

Matching on a variable rather than a node name means renaming the node cannot silently break
everything looking for it.

Access is enforced at the boundary between scripts: a blocked write warns and does nothing, a
blocked read returns nothing.

## Editing in VS Code

Desktop only. **Edit in VSCode** in the top bar mirrors the project's scripts to a real folder and
keeps the two in step.

What it sets up:

- a **real TypeScript project**, with a `tsconfig.json` mirroring the in-editor compiler options
  exactly, and the engine's declaration files, so your IDE and the editor agree about types;
- a hidden manifest mapping each script asset to its file.

**Two-way sync.** Editor changes are written out; changes on disk are pulled back in as renames,
updates, creates and deletes.

**Identity comes from the manifest, not the filename** — so renaming a file in your IDE is
understood as a rename, not as a delete plus an unrelated create.

**Status** is shown by a chip in the top bar: `off`, `connecting`, `live`, `paused`, `error`. From
it you can:

| Action | Does |
|---|---|
| **Disconnect** | Stop mirroring. |
| **Open in editor** | Jump to a script, optionally selecting its file. |
| **Resync** | Rewrite everything on disk from the library. |
| **Apply pending deletions** | Confirm deletions detected on disk. |
| **Resolve conflict** | *Keep external* or *keep mine*, when an outside edit lands on a script that has unsaved editor changes. |

Deletions are held rather than applied silently, because a delete is the one operation you cannot
undo by re-syncing.

## Scripts in a published build

Scripts are extracted and obfuscated at publish time and are resolved without `eval`. Nothing about
how you write them changes.

An instantiated copy of a scripted node resolves its script through the id it was copied *from*,
which is why spawning template instances works in a published game.

## Testing behaviour

The editor has no test runner, but the engine's own suite runs against the same public API your
scripts use. Where behaviour matters — a difficulty curve, a scoring rule — making the function
public rather than private is worth doing, so it can be exercised directly rather than only through
the game.

## See also

[Getting started (scripting)](../scripting/getting-started.md) · [Patterns](../scripting/patterns.md) · [Assets](assets.md)
