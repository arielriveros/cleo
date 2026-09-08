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
onAction(action: string, state: ActionState): void
onThink(delta: number): void                      // ControllerNode only
onDespawn(): void
```

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
despawn(): void
remove(): void
get hasStarted: boolean
get markForRemoval: boolean
```

| Call | Effect |
|---|---|
| `spawn()` | Wakes the node. Fires `onSpawn` **every time**; fires `onStart` only the first time. |
| `despawn()` | Sleeps it. No render, no update, no animation; body and trigger leave the world; **timers are cancelled**. |
| `remove()` | Despawn, then unlink at the next update. Permanent. |

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

## See also

[Node API](node-api.md) · [Scene and game](scene-and-game.md) · [Core concepts](../concepts.md#the-frame)
