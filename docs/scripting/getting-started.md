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

**Import the engine from `'cleo'`, and other scripts by their path.** `'cleo'` is the engine's public
API — see the [API index](../reference/api-index.md). Another script is imported by where it sits in
the Assets panel; see [Script modules](#script-modules) below.

**Public fields become node values.** A declared class field with a default shows up in the node's
inspector, so one script can drive many nodes at different settings. Prefix a field with `_` to
keep it internal.

**Anything else is ordinary TypeScript.** Helper methods, getters, private state, `async` — all fine.

## Script modules

Shared code lives in its own script and is imported by **project path** — the folder path in the
Assets panel without the `.script` extension. That path is also the file's path in the
[VS Code workspace](../editor/scripting-workflow.md), so the same import works in all three places:
the in-editor editor, VS Code and the running game.

```ts
// Assets: /Shared/Math.script            a MODULE: exports, but no default class
export const TAU = Math.PI * 2
export function clamp01(v: number) { return Math.max(0, Math.min(1, v)) }
export enum Team { Player, Enemy }
```

```ts
// Assets: /Enemies/Hollow.script
import { CharacterNode } from 'cleo'
import { clamp01, Team } from '@/Shared/Math'     // from the project root
import { lerp } from './Util'                     // relative to this script's folder
import EnemyBase from '../Shared/EnemyBase'       // another script's class

export default class Hollow extends EnemyBase { … }
```

- **`@/` is the project root.** A bare leading `/` is not accepted: TypeScript reads it as a path on
  your disk, so VS Code could never resolve it. `./` and `../` are relative to the importing script.
- **A script with exports but no default class is a module.** Create one with **+ Add ▸ Script
  Module**, or just write one. A module is never attached to a node; the node script picker does
  not list it.
- **A module runs once and is shared.** Every script importing it gets the same instance, and its
  top-level state lives for the whole game session, across `Game.loadScene`. A node's own script
  still runs once per node.
- **Base classes are inherited for real.** A class script extending another script's class gets its
  methods, getters and field defaults, and its fields appear in the inspector. A derived field's
  default wins over the base's; `super.onUpdate()` reaches the base. The node type the script can
  attach to follows the chain down to the engine class.
- **Exports:** functions, classes, `const`/`let`/`var`, enums, `export { a as b }`, re-exports, and
  a default. Types and interfaces are fine too. A destructured `export const { a } = …` is not.
- **Circular imports** work when the cycle only shares functions. A value read before its module has
  finished loading throws, and the error names the cycle.
- **Shared modules see public variables only.** `getData(node)` inside a module returns a node's
  public variables; pass a requester (`getData(node, this)` from a base-class method) for more.
- Only modules something imports are shipped in a published game.

> **How:** scripts are ES-module-*shaped* but are never loaded as modules. Imports are rewritten to
> lookups in the engine's module table, and each export becomes a getter on the script's exports
> object — all on the lines they were written on, so reported line numbers still match your
> source.

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
| `onTrigger(other)` | Needs a trigger on this node. Fires on first contact. |
| `onTriggerEnter(other)` / `onTriggerExit(other)` | A trigger overlap began / ended. Called on both nodes, once per frame after physics. |
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
