# Lifecycle

When each hook runs, what is guaranteed to exist by then, and how nodes come and go at runtime.

## The hooks

```ts
onConstruct(): void
onSpawn(): void
onStart(): void                                   // may be async
onUpdate(delta: number, time: number): void
onCollision(other: Node): void
onTrigger(other: Node): void
onTriggerEnter(other: Node): void                 // either side of a trigger overlap
onTriggerExit(other: Node): void
onAction(action: string, state: ActionState): void
onThink(delta: number): void                      // ControllerNode only
onRoomEnter(other: Node): void                    // a 2D camera's target entered a room (both sides)
onRoomExit(other: Node): void
onDespawn(): void
```

`onRoomEnter` / `onRoomExit` come from a [Camera 2D](../editor/tilemap-2d.md#2d-cameras-and-rooms): when the
node it follows walks into a Room, the node hears it with the room, and the room hears it with the node.

UI widgets add `onPress()`, `onValueChanged(value)` and `onSubmit(value)` — see [UI](ui.md).

Every hook is wrapped: a throw is caught, logged with the node's name under the `Script` category,
and the frame continues. An `async` hook's rejection is caught too.

## Order at scene start

1. `onConstruct` on **every** node, dormant ones included.
2. `onSpawn` on every awake node.
3. `onStart` on every awake node.

`onConstruct` replaces a constructor. Use it for anything that must exist before other nodes look
at this one, including on nodes that have not spawned yet.

`onStart` runs after node variables and per-node script field values have been restored, so it is
the first place where your tunables hold their authored values. This is where to resolve references:

```ts
onStart() {
  this._director = this.findNode('GameManager')
  if (!this._director) {
    Logger.warn('no GameManager, so the spawner cannot place anything', 'Script')
    return
  }
  this.after(this.intervalSeconds(), () => this._tick())
}
```

> Resolve once in `onStart` and cache. Four `findNode` calls a frame from four scripts are four
> whole-scene searches for values one node already has.

## Order within a frame

Where `onUpdate` sits relative to everything else is in [Core concepts](../concepts.md#the-frame).
The two consequences worth internalising:

- **`onAction` fires just before this frame's `onUpdate`**, and only on nodes that actually override
  it.
- **`onThink` runs in the control pass, before any `onUpdate`** — including its own node's. It runs
  *last* within that pass, after possession, aim and perception are resolved, so it patches an
  already-complete intent rather than competing with one.

A node added while the scene is already running has `onStart` fired immediately on `addChild`, so a
spawned node is never a frame behind.

## Spawning and despawning

A node can be **dormant**: present in the scene, findable, but not drawn, not updated, and with its
body and trigger out of the physics world.

```ts
get spawned: boolean
get/set spawnOnStart: boolean       // authored; ignored while merely authoring
spawn(options?: { subtree?: boolean }): void
despawn(options?: { immediate?: boolean; fade?: number }): void
remove(options?: { immediate?: boolean; fade?: number }): void
get isDespawning: boolean           // dissolving toward a despawn or removal
get despawnFade: number             // this node's own dissolve, 1 solid .. 0 gone
get effectiveFade: number           // times every ancestor's: what the renderer draws with
onFadeStart(): void                 // the dissolve began
get hasStarted: boolean
get markForRemoval: boolean
```

| Call | Effect |
|---|---|
| `spawn()` | Wakes the node. Fires `onSpawn` **every time**; fires `onStart` only the first time. |
| `despawn()` | Sleeps it. No render, no update, no animation; body and trigger leave the world; **timers are cancelled**. |
| `remove()` | Despawn, then unlink at the next update. Permanent. |

### Despawns are gradual during play

In play, `despawn()` and `remove()` dissolve anything visible in the subtree before acting. That
covers models, characters, sprites, lights, particles and decals. The dissolve uses the same
screen-door dither as a foliage LOD change.

- **Duration:** `scene.despawnFadeSeconds`, default `0.8`, saved with the scene. `{ fade: seconds }`
  overrides it for one call.
- **While it fades,** the node keeps updating and simulating, so a ragdoll keeps settling. Its timers
  keep running. Particles stop emitting and a decal's opacity follows the fade. Shadows drop out
  halfway.
- **When the fade ends,** the real despawn or removal happens and `onDespawn` fires.
- **Immediate cases:** `{ immediate: true }` acts at once. So does a subtree with nothing to draw,
  and anything done while authoring in the editor.
- **During a fade:** `spawn()` cancels it, and a later `remove()` turns a fading despawn into a
  removal.

```ts
this.after(this.corpseSeconds, () => this.remove({ fade: 1.5 }))   // a corpse dissolving away
weapon.remove({ immediate: true })                                 // a swap must not linger in the hand
```

`spawnOnStart` is the authored flag behind "this door exists but is not there yet". It is a
runtime-only rule: while you are authoring, a node marked `spawnOnStart: false` is still visible,
because an editor that hid it would be an editor you could not use.

> **A dormant node leaves every type-filtered scene list** — `scene.models`, `scene.lights`,
> `scene.controllers` and so on — but stays findable by name and id. That is exactly what makes
> `scene.findNode('Door').spawn()` the way back.

### `onDespawn` runs after the timers are gone

```ts
onDespawn() {
  // this.after(...) here would never fire — the node's timers were already cancelled
}
```

This is a real trap. A pickup that grants a temporary buff and then removes itself cannot schedule
the "take the buff away" timer on itself:

```ts
// ✗ wrong — the pickup despawns, so this never runs
onTrigger(other: Node) {
  (other as any).speedMultiplier = 2
  this.after(8, () => { (other as any).speedMultiplier = 1 })
  this.despawn()
}
```

```ts
// ✓ right — the countdown lives on the node that survives
onTrigger(other: Node) {
  (other as any).grantSpeed(8)
  this.despawn()
}
```

## Timers

Game-time, pause-aware, and cancelled when their node despawns.

```ts
wait(seconds: number): Promise<void>
after(seconds: number, cb: () => void): () => void      // returns a cancel function
every(seconds: number, cb: () => void): () => void
```

```ts
onStart() {
  this.every(1, () => this.tickClock())
  this.after(3, () => this.spawnWave())
}

async onStart() {
  await this.wait(2)
  this.playIntro()
}
```

### `every` versus a self-rescheduling `after`

`every` fixes its period when it is scheduled. If the interval is itself a function of game state —
a difficulty curve, say — you want `after` that reschedules itself, because that re-reads the curve
on every tick:

```ts
onStart() { this.after(this.intervalSeconds(), () => this._tick()) }

private _tick(): void {
  this.spawnOne()
  this.after(this.intervalSeconds(), () => this._tick())    // re-reads the curve
}

public intervalSeconds(): number {
  const level = Math.max(1, this.level)
  return Math.max(this.minInterval, this.baseInterval / (1 + this.levelRamp * (level - 1)))
}
```

Making `intervalSeconds` public rather than private is deliberate: it is the whole difficulty model,
and it deserves to be readable and testable on its own.

### Put long-lived timers on a long-lived node

Because timers die with their node, a spawner that lived on one of the things it spawns would stop
scheduling the moment that thing died. Give it its own node at the scene root.

## Pausing

`Game.pause()` / `Game.resume()` / `Game.togglePause()` stop `onUpdate`, physics and timers.
`Game.time` counts **unpaused** milliseconds.

Some things deliberately keep working while paused so a pause menu can function: UI layout still
solves, and a UI button still responds. A progress bar's smoothing freezes, because it advances in
`update`.

A paused game runs no `onUpdate`, so a pause menu cannot listen for the key that closes it there.
Listen in a late update instead, which runs every frame, paused or not:

```ts
onStart() {
  this._stop = this.scene.addLateUpdate(() => {
    if (Input.started('Pause')) Game.togglePause()
  })
}
onDespawn() { this._stop?.() }
```

## Time scale and hit-stop

`Game.timeScale` sets how fast game time runs: 1 is real time, 0.5 half speed, 0 stops the
simulation while scripts keep getting `onUpdate` with a delta of 0. It scales everything that
simulates: physics, timers, `onUpdate`'s delta, `Game.time`, animators, particles, cloth and AI. It
resets to 1 when a scene loads.

`Game.slowMotion(scale, seconds)` runs at `scale` for `seconds` of **real** time and then eases back.
`Game.hitStop(seconds = 0.08, scale = 0.2)` is the short version for impacts: when a blow lands, game
time drops to a fifth for a moment, so the hit reads as heavy without the stutter of a full freeze.
A hit-stop always holds at least two frames, so it still shows on a slow machine where 0.08 s is a
single frame. Overlapping calls keep the slower scale and the later end. `Game.clearSlowMotion()` ends
one early.

```ts
onHitLanded(heavy: boolean) {
  Game.hitStop(heavy ? 0.12 : 0.07)
}
```

Some things keep real time on purpose, so the game stays responsive through a hit-stop:

| Real time | Why |
|---|---|
| Input | An action pressed during slow motion still registers on that frame. |
| Camera rigs | Damping, collision and shake stay snappy. |
| UI | Layout and buttons. |
| Render effects | Foliage wind, clouds, water ripples and shader `u_time` run on the wall clock. |
| Audio | Sounds play at normal pitch and speed. |

`Game.effectiveTimeScale` is the scale the last frame ran at (the time scale times any slow motion),
and `Game.unscaledDelta` its real delta. A late update gets both deltas: `(delta, unscaledDelta)`.

## See also

[Node API](node-api.md) · [Scene and game](scene-and-game.md) · [Core concepts](../concepts.md#the-frame)
