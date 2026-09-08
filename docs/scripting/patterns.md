# Patterns

Recipes assembled from the shipped example game, and a consolidated list of the mistakes that cost
the most time.

---

## A game manager

One node at the scene root owning the clock, the score and the end condition. Everything else asks
it questions.

```ts
import { Node, Logger, clamp, lerp } from 'cleo'

export default class DirectorNode extends Node {
  public levelSeconds: number = 180
  public spawnRadius: number = 60
  public maxSlope: number = 35

  public level: number = 1
  public itemsFound: number = 0
  public itemsTotal: number = 0
  public finished: boolean = false

  private _elapsed: number = 0

  /** 0 at the start of the level, 1 at the end. */
  public get progress(): number { return clamp(this._elapsed / this.levelSeconds, 0, 1) }

  onUpdate(delta: number) {
    if (this.finished) return
    this._elapsed += delta
    if (this.progress >= 1) this.finish()
  }

  public addScore(n: number): void { this.itemsFound += n }

  public finish(): void {
    this.finished = true
    this.findNode('EndScreen')?.spawn()
  }
}
```

Public getters like `progress` are readable from other scripts and bindable as node values, so the
HUD needs no logic of its own.

## Placing things on the ground

```ts
public findGroundSpot(minPlayerDistance: number): number[] | null {
  const player = this.findNode('Playable')
  for (let attempt = 0; attempt < 24; attempt++) {
    // sqrt(u), not u — otherwise two thirds of the points land in the middle third of the disc
    const r = this.spawnRadius * Math.sqrt(Math.random())
    const a = Math.random() * Math.PI * 2
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r

    const at = this.groundAt(x, z)
    if (!at) continue

    if (player) {
      const p = player.worldPosition
      if (Math.hypot(at[0] - p[0], at[2] - p[2]) < minPlayerDistance) continue
    }
    return at
  }
  return null
}

private groundAt(x: number, z: number): number[] | null {
  const hit = this.scene?.physics.raycast([x, 200, z], [x, -50, z])
  if (!hit) return null
  if (hit.node !== null) return null           // hit something that is not the terrain
  const slope = Math.acos(Math.min(1, Math.abs(hit.normal[1]))) * 180 / Math.PI
  if (slope > this.maxSlope) return null       // too steep to stand on
  return hit.point
}
```

Failing to find a spot is not an error — the next attempt tries again.

## A pickup

```ts
export default class PickupNode extends Node {
  public score: number = 10
  public spinSpeed: number = 90
  public bobHeight: number = 0.15
  public bobSpeed: number = 2

  private _taken: boolean = false
  private _baseY: number = 0

  onStart() { this._baseY = this.position[1] }

  onUpdate(delta: number, time: number) {
    this.rotateY(this.spinSpeed * delta)
    this.setY(this._baseY + Math.sin(time * this.bobSpeed) * this.bobHeight)
  }

  onTrigger(other: Node) {
    if (this._taken) return                     // a trigger fires while overlapping, not once
    if (!other.getVariable('isPlayer')) return
    this._taken = true
    ;(this.findNode('GameManager') as any)?.addScore(this.score)
    this.despawn()
  }
}
```

## A temporary buff

The countdown must live on the node that **survives**, not on the pickup that grants it.

```ts
// on the player
export default class PlayerNode extends CharacterNode {
  public speedSeconds: number = 8
  public speedLeft: number = 0

  public grantSpeed(seconds: number): void { this.speedLeft = Math.max(this.speedLeft, seconds) }

  onUpdate(delta: number) {
    if (this.speedLeft > 0) {
      this.speedLeft = Math.max(0, this.speedLeft - delta)
      this.drive().speedScale = 1.6
    }
  }
}
```

```ts
// on the powerup
onTrigger(other: Node) {
  if (this._taken || !other.getVariable('isPlayer')) return
  this._taken = true
  ;(other as any).grantSpeed(this.duration)
  this.despawn()
}
```

Keeping the countdown on the player also gives the HUD something to draw.

## Marking a node for others to find

```ts
// publisher
onStart() { this.setVariable('isPlayer', true, 'boolean', 'public') }

// consumer
if (candidate.getVariable('isPlayer')) { /* … */ }
```

Match on a variable, never on a name. Renaming a node then cannot silently break every script that
was looking for it.

## Caching lookups

```ts
onStart() {
  this._director = this.findNode('GameManager')
  this._player   = this.findNode('Playable')
}
```

Four `findNode` calls per frame from four scripts are four whole-scene searches for values one node
already has.

## Warning about silent setups

```ts
onStart() {
  if (!this.body) Logger.warn(this.name + ' has no rigid body, so it cannot move', 'Script')
  const lc = this.body?.linearConstraints
  if (lc && (lc[0] === 0 || lc[1] === 0 || lc[2] === 0)) {
    Logger.warn(this.name + ' has a locked linear axis; movement along it is dead', 'Script')
  }
}
```

The three setups that break movement without an error — no body, a locked axis, a missing child —
are all cheap to check once.

## Switching scenes

```ts
export default class PlayButtonNode extends UIButtonNode {
  public targetScene: string = 'Level 1'
  onPress() { Game.loadScene(this.targetScene) }
}
```

## A pause menu

```ts
public togglePause(): void {
  Game.togglePause()
  if (Game.isPaused) { Input.enableMap('UI');  Input.disableMap('Gameplay') }
  else               { Input.enableMap('Gameplay'); Input.disableMap('UI') }
  this.findNode('PauseMenu')?.[Game.isPaused ? 'spawn' : 'despawn']()
}
```

UI layout still solves while paused and buttons still respond, so nothing else is needed.

---

## Gotcha index

Every trap in these docs, in one place.

### Transforms and values

- **Live references.** `position`, `rotation`, `quaternion`, `scale`, `worldPosition`,
  `worldQuaternion`, `worldScale`, `worldForward`, `getBoundingBox()`, `getBoundingSphere()`,
  `children`, and every resolved UI rect are **rewritten in place**. Copy to keep a value.
- **Writing through a transform getter skips the setter's bookkeeping** — no matrix recompose,
  nothing pushed into the physics body.
- **Rotations are degrees**, composed `Rz · Ry · Rx`, so the gimbal singularity is at **yaw ±90°**.
- **`setRotation` pushes into the physics body; `setQuaternion` deliberately does not.**
- **The `parent` setter only moves the pointer.** Use `addChild` to re-parent.
- **`getChildByName` is direct children only.** Walk the subtree yourself for a deep search.

### Motion

- **`velocity` is commanded; `planarSpeed` is measured.** A character against a wall keeps its
  velocity and reads a measured speed near zero.
- **Angles are counter-clockwise.** Right is `−90`, left is `+90`. `lateralSpeed` positive is left.
- **`turnRequest` has the opposite sign to `moveDir`** — it is a clip selector, not an angle.
- **`isGrounded` has a ~0.1 s grace.** Not "am I falling"; never gate movement *speed* on it.
- **Never write `velocity` on a `CharacterNode`.** Locomotion writes it every frame.
- **A bodied node must sit at the scene root.** `setBody` uses the world position, `setPosition`
  writes the local one.
- **An offset collider moves the centre of mass.** Call `recenterMass()`.
- **Use a capsule, not a box, for characters** on terrain.
- **Set character friction to 0.** The default 0.3 eats 26% of commanded speed.
- **A locked linear constraint axis silently kills movement along it.**

### Lifecycle

- **Timers die with their node**, and are cancelled *before* `onDespawn` runs.
- **Put long-lived timers on a long-lived node.**
- **`every` fixes its period; a self-rescheduling `after` re-reads the interval.**
- **A trigger fires while overlapping, not once.** Latch it.
- **Dormant nodes leave every typed scene list** but stay findable by name and id.
- **`Scene.dispose()` frees GPU and physics resources.** Never call it on a scene you are keeping.
- **Game time is not wall-clock time** — the frame delta is clamped at `0.333 s`.

### Input and control

- **A controller must poll `Input.started`, not use `onAction`** — `onAction` is dispatched after
  the control pass.
- **`onThink` runs last in the control pass.** It patches an intent; it does not compete with one.
- **A camera rig overwrites its camera child's whole local transform every frame.** Shoulder offsets
  go on `socketOffset`.
- **Keep a controller as the last child** of the pawn, behind the camera rig.

### AI

- **There is no faction system.** Every character is a candidate for every other.
- **Gate on `noticed`, not `visible`.**
- **Perception does not run while authoring.** Press Play.
- **`scene.ai` is optional.** Guard it.
- **`pathRemaining` and `neighborCount` compute on read.**
- **A brain asset is a copy, not a reference.** Unlinking or deleting one changes no behaviour.
- **A wandering agent that spins is turning too fast**, not broken.
- **`path` and `patrol` fall back to straight lines** with no baked navmesh.

### Animation

- **Bind Speed to the measured `planarSpeed`**, not to an intended speed.
- **Unsigned axes clamp at 0**, so a sample at a negative coordinate is unreachable.
- **Turn on `wrap` for a heading axis.**
- **Do not give a field state a playback speed as well** — the rate multiplies twice.
- **The `±` band on measured conditions is not optional.** Without it the machine ping-pongs.
- **Root motion belongs on turn clips, not on physics-driven locomotion.**

### UI

- **Assigning `value` does not fire `onValueChanged`.**
- **UI is the only family that persists `visible`.**
- **Tints are sRGB, not linear.**
- **A progress bar's smoothing freezes while paused.**

### Rendering and audio

- **With auto-exposure on, `exposure` is ignored** — ramp `exposureCompensation`.
- **`exposureMinEV` is a ceiling on brightness**, not a floor.
- **Do not write sky sun properties every frame** — each write forces a cubemap re-bake.
- **Call `skyLight.markDirty()`** if the sun moves, or indirect light freezes.
- **`alphaCutoff: 0` disables cutout.**
- **`lensDirtTexture: null` means the built-in mask**, not "off".
- **`play()` is silent when `scene.soundsEnabled` is false.**

### Scripts

- **Only the class may be exported.**
- **Public fields become inspector values;** `_`-prefixed ones stay hidden.
- **Script methods land as own properties on the node**, so engine work lives in `update()` and
  yours in `onUpdate()`.

## See also

[Scripting guide](README.md) · [Third-person character](../../examples/scripts/README.md) · [Night Shift](../../examples/scripts/NIGHT_SHIFT.md)
