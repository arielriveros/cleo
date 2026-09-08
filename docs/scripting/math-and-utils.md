# Math and utilities

Vectors, easing, raycasting and logging.

## Vectors and matrices

gl-matrix is re-exported whole as `Vec`:

```ts
import { Vec } from 'cleo'

const a = Vec.vec3.create()
Vec.vec3.subtract(a, target.worldPosition, this.worldPosition)
const distance = Vec.vec3.length(a)
Vec.vec3.normalize(a, a)

const q = Vec.quat.create()
Vec.quat.rotationTo(q, [0, 0, 1], a)
```

Positions and directions are plain `number[]` / typed arrays, so plain arithmetic works too, and is
often clearer for one-off maths:

```ts
const p = target.worldPosition
const self = this.worldPosition
const distance = Math.hypot(p[0] - self[0], p[1] - self[1], p[2] - self[2])
```

> Remember that `worldPosition` and friends are **live references rewritten in place**. Copy before
> storing: `const start = [...this.worldPosition]`.

`MathUtils` is the engine's own helper namespace, and four of its members are exported directly
because they come up constantly:

```ts
import { clamp, lerp, damp, dampTime } from 'cleo'

clamp(v: number, min: number, max: number): number
lerp(a: number, b: number, t: number): number
damp(current: number, target: number, lambda: number, delta: number): number
dampTime(current: number, target: number, smoothTime: number, delta: number): number
```

### `damp` versus `lerp`

`lerp(current, target, 0.1)` inside `onUpdate` is **frame-rate dependent**: it converges twice as
fast at 120 fps as at 60. `damp` takes the delta and does not.

```ts
// ✗ frame-rate dependent
this.armLength = lerp(this.armLength, wanted, 0.1)

// ✓ frame-rate independent
this.armLength = damp(this.armLength, wanted, 8, delta)

// ✓ the same, expressed as "reach it in about 0.2 s"
this.armLength = dampTime(this.armLength, wanted, 0.2, delta)
```

Prefer `dampTime` when a designer is going to tune the number — "how long it takes" is a question
people can answer.

## Angles

```ts
import { shortestAngle, wrapDegrees, aimFromDirection, headingAngle, signedAngleBetween } from 'cleo'
```

| Function | Use |
|---|---|
| `wrapDegrees(deg)` | Fold into a canonical range. |
| `shortestAngle(from, to)` | The signed difference, taking the short way round. This is what stops a turn going 350° the wrong way. |
| `aimFromDirection(dir)` | Yaw and pitch from a direction vector. |
| `headingAngle(...)` / `signedAngleBetween(...)` | The primitives the measured-motion angles are built on. |

Angles are **counter-clockwise**: right is negative. See
[Core concepts](../concepts.md#coordinate-and-sign-conventions).

## Raycasting

Two systems, for two questions.

**Against colliders** — the one you usually want. See
[Raycasting](motion-and-physics.md#raycasting).

**Against render geometry** — for picking, or for exact surface queries:

```ts
import { Raycaster } from 'cleo'

Raycaster.screenToRay(...)              // a ray from a screen position through the camera
Raycaster.raycast(...)                  // against nodes

interface RaycastHit { node: Node; point: vec3; normal: vec3; distance: number }
```

Exact triangle intersection goes through a node's BVH:

```ts
const bvh = node.getBVH()               // null for skinned meshes
rayTriangleIntersection(...)
```

A skinned mesh has no BVH — its triangles move every frame — so pick those with a collider instead.

`Frustum` is exported if you need to test visibility yourself.

## Logging

```ts
import { Logger } from 'cleo'

Logger.log(message: string, category?: string): void
Logger.warn(message: string, category?: string): void
Logger.error(message: string, category?: string): void
Logger.debug(message: string, category?: string): void
```

The category is the second argument, and the convention in game code is `'Script'`:

```ts
Logger.log(this.name + ' ready', 'Script')
Logger.warn('no GameManager, so the spawner cannot place anything', 'Script')
```

Messages reach the editor's console, where they can be filtered by level and text.
`Logger.debug` also raises a short-lived toast in the viewport, which is useful for something you
want to see without watching the console.

> **Warn about the setups that fail silently.** The most valuable thing a script can do in
> `onStart` is check its assumptions and say so: no rigid body, a locked movement axis, a missing
> child it needs. A one-line warning at start-up saves far more time than the same problem
> discovered later as "movement feels wrong in some directions".

## Base64

```ts
bytesToBase64(bytes: Uint8Array): string
base64ToBytes(s: string): Uint8Array
bytesToDataUrl(bytes: Uint8Array, mime: string): string
parseBase64DataUri(uri: string)
```

Mostly used for save data and embedded assets.

## Statistics

```ts
import { frameStats, sceneStats, physicsStats, aiStats } from 'cleo'
```

Read the same numbers the editor's performance HUD shows — handy for an in-game debug overlay. See
[Rendering (editor)](../editor/rendering.md#performance-hud).

## See also

[Node API](node-api.md) · [Motion and physics](motion-and-physics.md) · [API index](../reference/api-index.md)
