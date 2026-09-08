# Scene and game

Spawning things, moving between scenes, and the session-level facade.

## The `Game` facade

The script-facing surface for anything above a single scene.

```ts
import { Game } from 'cleo'

Game.loadScene(nameOrId: string): void | Promise<void>
Game.sceneName: string
Game.sceneNames(): string[]

Game.isPaused: boolean
Game.pause() ; Game.resume() ; Game.togglePause()
Game.time: number                          // milliseconds of UNPAUSED game time

Game.gravity: [number, number, number]     // get and set

Game.getRenderSettings(): RenderSettings | undefined
Game.updateRenderSettings(settings: Partial<RenderSettings>): void
```

```ts
export default class PlayButtonNode extends UIButtonNode {
  onPress() { Game.loadScene('Level 1') }
}
```

`Game.loadScene` throws if no host is installed — that only happens outside the editor and the
published player, so in practice it always works.

## The scene

```ts
get root: Node
get nodes: Set<Node>                       // SPAWNED nodes only
get activeCamera: CameraNode | undefined
setActiveCamera(node: CameraNode | null): void

findNode(name: string): Node | undefined
getNodesByName(name: string): Node[]
getNodeById(id: string): Node | undefined

addNode(n: Node) ; addNodes(...n: Node[])
removeNode(n: Node) ; removeNodesByName(name: string) ; removeNodeById(id: string)

instantiate(nameOrId: string, options?: InstantiateOptions): Node | null

get/set ambientLight: vec3                 // in LUX
get/set environmentMap: Texture | null
get/set animationsEnabled / soundsEnabled / spawnRulesEnabled
get hasStarted: boolean
get stats: SceneStats

physics: PhysicsSystem
ai?: AISystem                              // OPTIONAL — always guard
```

### Typed node sets

The scene keeps lists per node kind, rebuilt lazily when the tree changes: `lights`, `models`,
`sprites`, `landscapes`, `tilemaps`, `lodGroups`, `cameraRigs`, `characters`, `controllers`,
`navMeshes`, `sounds`, `lightProbes`, `uiRoots`, `uiNodes`, `skybox`, `volumetricClouds`,
`skyAtmosphere`, `skyLight`.

```ts
for (const light of this.scene.lights) light.castShadows = false
```

> These contain **spawned nodes only**. A dormant node is absent from every one of them while
> staying findable by name and id.

## Spawning from templates

```ts
interface InstantiateOptions {
  parent?: Node
  name?: string
  position?: number[]
  rotation?: number[]
  scale?: number[]
}
```

```ts
const zombie = this.scene?.instantiate('Zombie', {
  position: at,
  rotation: [0, Math.random() * 360, 0],
})
if (!zombie) {
  // instantiate already logged the template names it knows about; say why we are giving up
  Logger.warn('no "Zombie" template, so no zombies', 'Script')
  return
}
```

`instantiate` deep-copies the template, regenerates every node id, remaps internal references so a
copy points at **its own** parts, **always spawns** (overriding the template's `spawnOnStart`), and
fires `onSpawn` then `onStart` before returning.

The reference keys that get remapped are `followId`, `lookAtId`, `cameraNodeId`, `uiTargetId`,
`focusTargetId`, `possessedId`, `aimSourceId`, `navMeshId` and `collisionIgnoreIds`. References
pointing *outside* the copied subtree are deliberately left alone.

### The template registry

```ts
registerTemplates(list: NodeTemplate[]): void
clearTemplates(): void
getTemplate(nameOrId: string): NodeTemplate | undefined
templateNames(): string[]
```

The registry is **global**, not per scene, and loading a scene must not clear it. Duplicate names
warn and the first wins.

## A complete spawner

```ts
import { Logger, Node, clamp, lerp } from 'cleo'

export default class SpawnerNode extends Node {
  public templateName: string = 'Zombie'
  public baseInterval: number = 6
  public levelRamp: number = 0.35
  public minInterval: number = 0.8
  public maxAlive: number = 14
  public minPlayerDistance: number = 18

  private _director: Node | null = null
  private _live: Node[] = []

  onStart() {
    this._director = this.findNode('GameManager')
    if (!this._director) {
      Logger.warn('no GameManager, so the spawner cannot place anything', 'Script')
      return
    }
    this.after(this.intervalSeconds(), () => this._tick())
  }

  private _tick(): void {
    // Drop the ones that removed themselves, so maxAlive counts what is actually alive.
    this._live = this._live.filter(z => z && z.scene && !z.markForRemoval)

    if (this._live.length < this.maxAlive) this._spawnOne()
    this.after(this.intervalSeconds(), () => this._tick())
  }

  public intervalSeconds(): number {
    const director = this._director as any
    const level = Math.max(1, director?.level ?? 1)
    return Math.max(this.minInterval, this.baseInterval / (1 + this.levelRamp * (level - 1)))
  }

  private _spawnOne(): void {
    const at = (this._director as any).findGroundSpot(this.minPlayerDistance)
    if (!at) return                    // no walkable spot this tick; the next one tries again
    const node = this.scene?.instantiate(this.templateName, { position: at })
    if (node) this._live.push(node)
  }
}
```

Three things this does deliberately:

- It lives on **its own node at the scene root**, because timers die with their node — a spawner
  living on one of the things it spawns would stop scheduling when that thing died.
- It reschedules with `after` rather than using `every`, so the interval can change as the game
  gets harder.
- Failing to find a spot is not an error. The next tick tries again from scratch.

## The event bus

```ts
import { engineEventBus } from 'cleo'

engineEventBus.on('SCENE_CHANGED', change => { /* … */ })
engineEventBus.off(…) ; engineEventBus.once(…) ; engineEventBus.emit(…)
```

| Event | Payload |
|---|---|
| `SCENE_CHANGED` | `SceneChange { kind, node?, prop?, prev?, next? }` |
| `LOG` / `LOG_UPDATE` / `LOG_CLEAR` | Logger traffic |
| `RENDER_SETTINGS_CHANGED` | |
| `INPUT_ACTION` / `INPUT_MAP_CHANGED` | |

`ChangeKind` is one of `structure`, `visibility`, `name`, `transform`, `variable`, `physics`,
`script`, `material`, `texture`, `light`, `camera`, `environment`, `component`. A `structure`
change also carries a `StructureOp`: `add`, `remove`, `reparent`, `reparent-detach`, `spawn`,
`despawn`, `sleep`.

> Property-level events are gated on authoring mode, which is **off** in a published game, so a
> shipped game pays nothing for them. Structural events always fire, because the scene itself
> depends on them. Do not build gameplay on the property-level events — they will not be there.

## Scene lifecycle

```ts
scene.start() ; scene.stop() ; scene.update(delta, time, paused)
scene.dispose()
```

> **`dispose()` frees GPU meshes, physics bodies, terrain and sounds.** Call it only on a scene you
> are throwing away. Never on one you intend to keep.

## Cameras

```ts
scene.setActiveCamera(node: CameraNode | null): void
```

This **pins** the active camera. Loading a scene clears the pin, so set it after the scene is in
place rather than before.

## Timers on the scene

The node-level `after` / `every` / `wait` are the ones to use. The scene-level equivalents exist
because that is where the timers actually live:

```ts
scene.scheduleAfter(node, seconds, cb): () => void
scene.scheduleEvery(node, seconds, cb): () => void
scene.cancelTimers(node): void
```

## See also

[Lifecycle](lifecycle.md) · [UI](ui.md) · [Publishing (editor)](../editor/publishing.md) · [Patterns](patterns.md)
