# Scripting workflow

Creating scripts, attaching them, tuning them per node, and — if you prefer — editing them in
VS Code.

How to *write* a script is [Getting started](../scripting/getting-started.md).

## Creating a script

**Assets ▸ + Add ▸ Script**, or select a node and use the Behaviors panel's **+ Create Script**.

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
- Select the node, open the **Behaviors** panel, and pick the script.
- Drop it on a node in the viewport.

Hovering a script card in the Assets panel **highlights every node using it**, which is the quickest
answer to "what is this attached to".

One script asset can be attached to many nodes. It is shared: editing it changes all of them.

## The Behaviors panel

The panel works on the selected node: which script it runs, and that node's own values for the
script's attributes. The source itself is edited in the script's tab, not here. On a node inside a placed
template instance the script is the template's, so only the values of its **public** attributes stay
editable, and each edit becomes that instance's override; private and protected ones are set in the
template. The instance root also lists the public attributes of every behavior inside it
([public attributes](scene-authoring.md#templates)).

**Script** — the slot that links a script asset to the node. **+ Create Script** makes a new
class-based script for it and opens it; **Link existing…** lists the scripts whose base class can sit
on this node type; a script dragged from the Assets panel onto the slot links too. ✎ opens the linked
script, ✕ removes it from the node and keeps the asset.

**Attributes** — with a script linked, the fields it marks `@attribute` and this node's values for them
([attributes](#attributes)). An attribute with a group (`@attribute('Combat')`) has a section of its own
below, titled with the group.

## Attributes

A script decides what the panel shows: a field marked `@attribute` appears as an editable value on
**that node**, whatever its access (public, protected or private). Every other field is the script's own
state, and is neither shown nor stored per node. Name, type and access come from the script; only the
value is edited here, and the field's doc comment is the row's tooltip.

```ts
import { Node, attribute } from 'cleo'

export default class SpawnerNode extends Node {
  /** Template to instantiate. */
  @attribute public templateName: string = 'Zombie'
  @attribute('Timing', { min: 0.5, max: 30 }) public interval: number = 6
  @attribute('Timing') private maxAlive: number = 14

  private live: Node[] = []      // not an attribute: not shown
}
```

One spawner script can drive an easy spawner and a hard one with no code duplication.

`@attribute` takes a group name, options, or both:

| Option | Effect |
|---|---|
| `label: 'Max HP'` | The row's name, instead of the field's. |
| `min`, `max`, `step` | A number within a range: a slider, and values clamped to it. |
| `readonly: true` | Shown, not editable. |
| `showIf: 'flag'` / `showIf: ['mode', 'ranged']` | Shown only while another attribute is truthy, or equals that value. |
| `color: true` | An `[r, g, b]` field picked with a colour picker. |
| `multiline: true` | A string edited in a text area. |

Arguments must be written out (`'Combat'`, `{ min: 0 }`): the editor reads them from the source without
running it, and ignores one it cannot read.

Supported types are `number`, `string`, `boolean`, `vec3` and `string[]` (an editable list). A string
attribute can be picked rather than typed:

- typed `ClipName`, `SoundName`, `SocketName`, `TemplateName` or `NodeName`, it offers the names this
  node can reach;
- typed `TriggerName`, it offers the triggers of the character's animator — and only those: a trigger is
  picked, never typed. The script and VS Code editors check every `TriggerName` (and `setTrigger`'s
  argument) against the triggers the project's animators declare, so a misspelt one is an error;
- typed as a literal union (`'a' | 'b'`), it offers those choices;
- decorated `@options('listField')` (or tagged `/** @options listField */`), it offers the entries of that list field;
- decorated `@pick('clip')` (or tagged `/** @pick clip */`), it offers the names of that kind.

See [Decorators](../scripting/decorators.md). Fields decorated `@child` or `@find` are filled with a node by the
engine and shown as `Finds: field → Name`, not as values; fields kept by `@save` without being attributes
are listed as **Also saved**.

A value edited on a node is saved with the scene and overrides the code default. Changing the
default in code affects only the nodes that have never had that field edited.

## Node variables

Separate from script fields, and used differently: variables are created at runtime, by scripts. Each carries a type and an **access
modifier** (`public` / `protected` / `private`), and they are meant for *other* scripts to read. In a
script they are plain properties of the node — `this.isPlayer`, or `other.health` on another node —
and the editor type-checks them as you type.

The usual use is a marker:

```ts
onStart() { this.setVariable('isPlayer', true, 'boolean', 'public') }
```

Matching on a variable rather than a node name means renaming the node cannot silently break
everything looking for it.

Access is enforced at the boundary between scripts: `public` is open to any node, `protected` to the
node and its descendants, `private` to the node alone. A blocked write warns and does nothing, a
blocked read returns nothing.

## Editing in VS Code

Desktop only. In **Options ▸ Editor ▸ Scripts**, set *Open scripts with* to **VSCode** (or choose the
workspace folder there): the project's scripts are mirrored to a real folder, kept in step, and opening
a script opens its file in your editor. In the browser the option is greyed out.

What it sets up:

- a **real TypeScript project**, with a `tsconfig.json` mirroring the in-editor compiler options
  exactly, and the engine's declaration files, so your IDE and the editor agree about types;
- a hidden manifest mapping each script asset to its file;
- a `.vscode/launch.json` with **Attach to the Cleo game**, when the folder has none, for debugging the
  game from VS Code: see [Debugging in VS Code](debugging.md#debugging-in-vs-code).

**Two-way sync.** Editor changes are written out; changes on disk are pulled back in as renames,
updates, creates and deletes.

**Identity comes from the manifest, not the filename** — so renaming a file in your IDE is
understood as a rename, not as a delete plus an unrelated create.

**Status** is shown in Options ▸ Editor ▸ Scripts: `off`, `connecting`, `live`, `paused`, `error`.
The top bar shows a chip only while the sync is `paused` or in `error`. From either you can:

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

## Debugging

A script error in the Console links to its line, and the script editor marks the lines that failed in
the last run. In the desktop app you can set breakpoints in the script editor's margin and step through a
game that plays in a window: see [Debugging scripts](debugging.md).

## Testing behaviour

The editor has no test runner, but the engine's own suite runs against the same public API your
scripts use. Where behaviour matters — a difficulty curve, a scoring rule — making the function
public rather than private is worth doing, so it can be exercised directly rather than only through
the game.

## See also

[Getting started (scripting)](../scripting/getting-started.md) · [Patterns](../scripting/patterns.md) · [Debugging scripts](debugging.md) · [Assets](assets.md)
