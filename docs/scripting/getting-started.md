# Getting started with scripts

A script is **one TypeScript class** that extends a node type and is the file's default export. The
editor attaches it to a node; from then on `this` *is* that node.

```ts
import { Node, Logger } from 'cleo'

export default class DoorNode extends Node {
  /** Seconds the door takes to open. Editable per node. */
  public openTime: number = 1.5
  private _open: boolean = false

  onStart() {
    Logger.log(this.name + ' ready', 'Script')
  }

  onTrigger(other: Node) {
    if (!this._open) this.open()
  }

  public open(): void {
    this._open = true
    this.after(this.openTime, () => Logger.log('open', 'Script'))
  }
}
```

## The rules

**One class, default-exported.** The class name is yours; the convention in the shipped examples is
`SomethingNode`.

**Extend the node type the script sits on.** A script on a plain node extends `Node`; a script on a
character extends `CharacterNode`; a script on a UI root extends `UIRootNode`. The base class is
resolved **by class name**, which is why every node class is exported individually from `cleo`.

**`import … from 'cleo'` is the only import.** It resolves to the engine's public API — see the
[API index](../reference/api-index.md).

**Public fields become node values.** A declared class field with a default shows up in the node's
inspector, so one script can drive many nodes at different settings. Prefix a field with `_` to
keep it internal.

**Anything else is ordinary TypeScript.** Helper methods, getters, private state, `async` — all fine.

## What you may not write

Only the class may be exported. A second top-level `export` throws at compile time:

```ts
export const SPEED = 5          // ✗ not allowed
export function helper() {}     // ✗ not allowed
export default class …          // ✓ this is the one
```

Put constants and helpers inside the class, or as non-exported module-level declarations.

> **Why:** scripts are ES-module-*shaped* but are never loaded as modules. `import … from 'cleo'`
> is rewritten to a lookup in the engine's module table, and `export default class` is rewritten to
> `return ` **on the same line**, so reported line numbers still match your source. There is no
> second slot for a named export to land in.

## Fields, and how they reach the inspector

```ts
export default class SpawnerNode extends Node {
  /** Template to instantiate. */
  public templateName: string = 'Zombie'
  /** Seconds between spawns. */
  public interval: number = 6
  /** Hard cap on live instances. */
  public maxAlive: number = 14

  private _live: Node[] = []      // hidden from the inspector
}
```

The defaults you write are harvested once and used as the starting value; a per-node value edited
in the inspector overrides it and is saved with the scene. Changing a default in code changes only
the nodes that have never had that field edited.

Supported field types are `number`, `string`, `boolean` and `vec3`. Anything else is fine as
private state but will not appear in the inspector.

## Node variables versus script fields

Two similar-looking things, used differently:

| | Script field | Node variable |
|---|---|---|
| Declared | as a class field | at runtime with `setVariable`, or in the Variables panel |
| Typed | by TypeScript | by a `NodeVariableType` string |
| Read | `this.health` | `node.getVariable('health')` |
| Access control | none — it is a property | `public` / `private` / `protected` |
| Good for | this script's own tuning and state | marking a node for *other* scripts to find |

A common pattern is to publish a marker so unrelated scripts can identify a node without matching
on its name — renaming the node then cannot silently break them:

```ts
onStart() { this.setVariable('isPlayer', true, 'boolean', 'public') }
```

```ts
// elsewhere
if (candidate.getVariable('isPlayer')) { /* … */ }
```

See [Node variables](node-api.md#variables).

## Talking to other nodes

```ts
const manager = this.findNode('GameManager')      // by name, whole scene
const byId    = this.getNodeById(someId)
const kids    = this.getChildByName('Muzzle')     // direct children only
```

Scripts on other nodes expose their public methods and fields directly:

```ts
const director = this.findNode('GameManager') as any
if (!director.isDay) this.spawnOne()
```

The `as any` is the usual idiom, because the editor does not know at compile time which script
class sits on the node you just looked up.

> `getChildByName` searches **direct children only**. To search a whole subtree, walk it — see the
> `_find` helper in [UI](ui.md#writing-a-hud).

## Lifecycle in one table

| Hook | When |
|---|---|
| `onConstruct()` | Once per scene load, dormant nodes included. |
| `onSpawn()` | Once per life — at scene start, or every `spawn()`. |
| `onStart()` | Once per node lifetime, after variables are restored. May be `async`. |
| `onUpdate(delta, time)` | Every frame while running and unpaused. |
| `onCollision(other)` | Needs a body on **both** nodes. |
| `onTrigger(other)` | Needs a trigger on this node. |
| `onAction(action, state)` | Just before this frame's `onUpdate`. |
| `onThink(delta)` | Controllers only. Runs last in the control pass. |
| `onDespawn()` | On `despawn()`, `remove()`, or a parent going away. |

UI widgets add `onPress()`, `onValueChanged(value)` and `onSubmit(value)`.

Every hook is exception-guarded: a throw is logged with the node's name and does not kill the
frame. Full detail in [Lifecycle](lifecycle.md).

## Where scripts live

Script assets live in the project's library, not on disk, and are edited in the editor's code
editor. You can also mirror them to a real folder and edit them in VS Code — see
[Scripting workflow](../editor/scripting-workflow.md).

## See also

[Lifecycle](lifecycle.md) · [Node API](node-api.md) · [Patterns](patterns.md) · [Scripting workflow (editor)](../editor/scripting-workflow.md)
