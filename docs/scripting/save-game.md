# Saving and loading

Checkpoints, save slots, Continue, and a world that stays the way the player left it.

A save is opt-in. Nothing is saved unless you say so, in one of three ways:

- **Saved nodes.** Turn on **Saved** in a node's [Save card](../editor/node-inspector.md#common-sections),
  or set `node.saved = true`. The save keeps its transform, whether it is spawned, its body's motion and
  its node variables, and remembers it if it is removed.
- **`@save` fields.** Tag a script field `/** @save */` and the save keeps its value.
- **Globals.** `SaveGame.set(key, value)` keeps progress that belongs to no node: souls, flags, an
  inventory, which bonfire the player rested at.

A script can also save data of its own with `onSave()` and get it back in `onRestore(data)`.

The same state is also the **scene's memory**. When `Game.loadScene` leaves a scene, its Saved nodes
and `@save` fields are recorded. When the player comes back, the scene is built with them put back: a
pulled lever stays pulled, a taken pickup stays gone. A save writes all of that out, for every scene
visited; a load replaces it and builds the scene the save was made in.

## The `SaveGame` facade

```ts
import { SaveGame } from 'cleo'

SaveGame.set(key: string, value: unknown): void      // plain data; a copy is kept; undefined removes it
SaveGame.get<T>(key: string, fallback?: T): T          // a fresh copy each time
SaveGame.has(key: string): boolean
SaveGame.unset(key: string): void
SaveGame.keys(): string[]

SaveGame.save(slot?: string, options?: { label?: string }): Promise<SaveSlotInfo>   // slot defaults to 'auto'
SaveGame.load(slot?: string, options?: { loadingScreen?: boolean | { title?: string } }): Promise<void>
SaveGame.list(): Promise<SaveSlotInfo[]>               // newest first
SaveGame.exists(slot?: string): Promise<boolean>
SaveGame.delete(slot: string): Promise<void>
SaveGame.mostRecent(): Promise<SaveSlotInfo | null>    // what Continue loads
SaveGame.newGame(): void                                // clear the globals and every scene's memory

SaveGame.onMigrate((doc: SaveDocument, fromVersion: number) => SaveDocument | void): () => void

SaveGame.available: boolean      // a store is installed: Play, Play in window, a published build
SaveGame.isLoading: boolean
SaveGame.loadedFrom: string | null   // the slot this session was loaded from
SaveGame.playTime: number            // seconds of play, counting what the loaded save had
SaveGame.version: number             // the game's save version (Options ▸ Project ▸ General ▸ Saves)

// SaveSlotInfo: { slot, label, savedAt (ISO), playTime, scene: { id, name }, gameVersion, size }
```

A checkpoint that saves, and a title screen that continues:

```ts
import { Node, SaveGame } from 'cleo'

export default class CheckpointNode extends Node {
  /** @save */
  public lit = false

  onTriggerEnter(other: Node) {
    if (this.lit || other.name !== 'Player') return
    this.lit = true
    SaveGame.set('respawn', this.name)
    void SaveGame.save('auto', { label: this.name })
  }
}
```

```ts
import { UIButtonNode, SaveGame, Game } from 'cleo'

export default class ContinueButtonNode extends UIButtonNode {
  async onStart() { this.visible = await SaveGame.exists('auto') }
  onPress() { void SaveGame.load('auto', { loadingScreen: true }) }
}
```

`SaveGame.load` builds the saved scene again from its authored data, then puts the saved state back.
The scene being left is not recorded: loading undoes it. The promise resolves once the loaded scene has
started.

> A slot is a file name on the desktop: 1 to 64 letters, digits, `_`, `-` and `.`, not starting with a
> dot, and none of the names Windows reserves (`CON`, `NUL`, `COM1`...). Anything else throws.

> Saving throws outside of a running game (`SaveGame.available` is false): in the editor while not
> playing, or in a test with no store.

## What a save keeps

| Opt-in | Kept |
|---|---|
| **Saved** node | Local position, rotation (as a quaternion, exactly) and scale; whether it is asleep; its own body's linear and angular velocity; its node variables (not the editor's `__` ones); that it was removed |
| `@save` field | The field's value, on any node, Saved or not |
| `onSave()` | Whatever it returns, handed to `onRestore(data)` |
| Saved copy of a template | Made again from its template, under the same id and parent, with its own state and its inner nodes' |
| `SaveGame.set` | The value, until `newGame` or a load replaces it |

Values must be plain data: numbers, strings, booleans, `null`, arrays and plain objects. Two more kinds
are converted on the way: typed arrays (a `vec3` is one) and **other nodes**, which come back as the same
node, found by id and else by name path. Anything else (a function, a `Map`, a class instance, `NaN`) is
left out with one warning that names the field, and the rest is saved.

A node made by `scene.instantiate` comes back only when it is **Saved**: flag the template's root
(a bloodstain, a dropped item), or set `saved = true` on the copy. A copy that is not Saved is the
spawning script's business: save what it needs to spawn it again (`/** @save */ bossDefeated`).

> Nodes made in code with `new Node(...)` and nodes moved to another parent at runtime are not made
> again: only authored nodes and Saved template copies are.

## Hooks

```ts
onSave(): unknown            // what to keep; runs on save and when the scene is left
onRestore(data: unknown)     // after onConstruct, before onSpawn and onStart; dormant nodes too
wasRestored: boolean         // read-only: a save or the scene's memory restored this node
saved: boolean               // get and set
saveFields: readonly string[] // its @save fields
```

When a scene is built with saved state, the order is:

1. Saved transforms, dormancy, variables and `@save` fields are written in before anything runs. They are
   there for every handler, as authored values are.
2. `onConstruct` (every node).
3. `onRestore(data)` on each restored node.
4. `onSpawn`, then `onStart`.

> Guard first-time setup with `wasRestored`, or `onStart` overwrites what came back:
>
> ```ts
> onStart() { if (!this.wasRestored) this.lit = this.startLit }
> ```

> `onSave` must return its data directly. An `async onSave` returns a promise, which is not saved (a
> warning says so).

## Old saves and new builds

Every save records the engine's format version and the game's own **save version** (Options ▸ Project
▸ General ▸ Saves). When a game's saved data changes shape, raise the save version and register a
migration before loading, from the scene that loads (a title screen's `onStart`):

```ts
SaveGame.onMigrate((doc, from) => {
  if (from < 2) doc.globals.gold = doc.globals.coins
})
```

A save made by a newer engine is refused rather than half read. A node a save names but the new build
does not have is skipped. One whose id changed (a template rebuilt in the editor) is found again by its
name path, so keep the names of Saved nodes and their parents stable between releases.

## Where saves are kept

| Running in | Saves go to |
|---|---|
| The editor (Play, Play in window) | The project's Play saves, listed in the [Saves panel](../editor/saves.md) |
| A published desktop game | Files in `<app data>/<save folder>/saves`: `%APPDATA%` on Windows |
| A published web game | The browser's storage for the site, under the game's save folder name |

See [Publishing](../editor/publishing.md#saves) for what that means for players.

## See also

[Lifecycle](lifecycle.md) · [Scene and game](scene-and-game.md) · [Node API](node-api.md) ·
[Saves panel](../editor/saves.md) · [File formats](../reference/file-formats.md#save-files--cleosave)
