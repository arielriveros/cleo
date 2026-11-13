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
| `shortestAngle(degrees)` | Wrap an angle into (-180, 180]. Pass a difference, `shortestAngle(to - from)`, for the signed step the short way round: this is what stops a turn going 350° the wrong way. |
| `aimFromDirection(dir)` | Yaw and pitch from a direction vector. |
| `headingAngle(...)` / `signedAngleBetween(...)` | The primitives the measured-motion angles are built on. |

Angles are **counter-clockwise**: right is negative. See
[Core concepts](../concepts.md#coordinate-and-sign-conventions).

## The rest of `MathUtils`

Every math helper the engine uses lives in one module and is reachable as `MathUtils.name`:

```ts
import { MathUtils } from 'cleo'

const rand = MathUtils.seededRandom(42)        // the same sequence on every run
const gust = MathUtils.smoothstep(0.2, 0.8, rand())
```

Angles are degrees unless the name says otherwise. Tuple helpers take and return plain `[x, y, z]`
arrays (`Vec3Tuple`); quaternions are `[x, y, z, w]`.

| Function | Use |
|---|---|
| `DEG2RAD`, `RAD2DEG` | Degree and radian conversion factors. |
| `clamp01(v)` | `clamp(v, 0, 1)`. NaN passes through. |
| `clampFinite(v, lo, hi, fallback)` | Clamp, or `fallback` when `v` is not a finite number. |
| `smoothstep(e0, e1, x)` | The shader `smoothstep`, including equal edges. |
| `hermite(p0, m0, p1, m1, s)` | Cubic Hermite between two values with slopes. |
| `finiteOr(v, fallback)` | `v` when it is a finite number, else `fallback`: for reading saved or authored data. |
| `finiteOrUndefined(v)` / `nonNegativeOr(v, fallback)` | The same for optional fields, and for values that cannot be negative. |
| `dampVec3` / `dampVec3Time` | `damp` / `dampTime` per component of a vector. |
| `smoothToward(current, target, seconds, delta)` | `dampTime` that never moves on a paused frame. |
| `dampWrapped` / `dampAngleDeg` / `wrapSpan` / `deltaWrapped` / `deltaAngleDeg` | Damping and differences along the short way round a cycle. |
| `applyCurve(v, exponent)` | Response curve: the magnitude raised to `exponent`, sign kept. |
| `normalizeVec2(out, x, y)` | Clamp a 2D input to the unit disc; `[0, 0]` stays `[0, 0]`. |
| `forwardFromYaw(out, yaw)` / `rightFromYaw(out, yaw)` | A world yaw's forward and right vectors. |
| `yawFromDirection(x, z)` | The yaw that faces a planar direction. |
| `planarSplit(v, up)` / `facingComponents(v, forward, up)` | A vector split along and across gravity, or along and across a facing. |
| `angleBetween(a, b)` | Unsigned angle between two unit directions. |
| `quatAngle(q)` / `quatAngleDeg(q)` | A rotation's angle, in radians / degrees. |
| `eulerFromQuatDeg(out, q)` / `decomposeTRS(m, t, r, s)` | Euler angles from a quaternion; a matrix split into translation, rotation and scale. |
| `seededRandom(seed)` / `lcgRandom(seed)` | Deterministic random streams in [0, 1). |
| `cellNoise(col, row, seed)` / `hash01(x, z, yaw, salt)` / `hash12(x, y)` | Deterministic hashes in [0, 1). |
| `noise1(x, seed)` / `fbm1(x, seed, octaves)` / `valueNoise1(t, seed)` | Smooth 1D noise in [-1, 1]. |
| `valueNoise(x, y)` / `fbm2(x, z, seed)` | Smooth 2D value noise, and four octaves of it. |
| `windPerlin(x, y)` / `windPerlinGrad(x, y)` | The wind field's 2D Perlin noise, and its gradient. |
| `angularNoise(rng, lobes)` | Noise around a circle, for irregular round shapes. |
| `evaluateKeyedNumber` / `evaluateKeyedVector` / `evaluateKeyedStep` | A keyed curve (`KeyedCurve`, keys in seconds) at a time. |
| `keyedCurveWidth(curve)` / `rampWeight(start, end, easeIn, easeOut, t)` | A keyed curve's vector size; the eased weight of a span of time. |
| `evaluateCurve` / `evaluateGradient` / `parseCurve` / `parseGradient` | Normalized-time curves and colour gradients, as particle modules use. |
| `constantCurve` / `linearCurve` / `whiteGradient` / `fadeGradient` | Ready-made curves and gradients. |
| `new Spline3(points)` | A constant-speed path through points: `pointAt(u)`, `tangentAt(u)`, `length`. |
| `dot3` / `cross3` / `add3` / `sub3` / `scale3` / `lerp3` / `length3` / `distSq3` | Tuple vector arithmetic. |
| `normalize3(a)` / `normalize3OrZero(a)` | Unit vector; the second gives `[0, 0, 0]` for a zero vector. |
| `quatRotateTuple` / `quatConjugateTuple` / `quatMultiplyTuple` / `quatFromBasis` | Tuple quaternion arithmetic, and a rotation from three axes. |
| `mirrorQuat(out, q, n)` / `reflectVec3(out, v, n)` | Mirror a rotation or a vector across a plane. |
| `unitDirection(d, out)` / `transformDirectionTuple` / `transformPointTuple` | Normalize a direction; a direction or point through a matrix. |
| `octEncode` / `octDecode` / `octWrap` / `octWrapOutside` | The octahedral direction map the G-buffer and probes use. |
| `rayTriangleIntersection` / `raySphereIntersection` / `rayBoxIntersection` | The ray distance to a triangle, sphere or box, or null. |
| `closestOnSegment` / `closestSegmentSegment` / `closestSegmentBox` | Closest points between points, segments and boxes. |
| `clampToBox(p, half)` / `boxesOverlap(...)` | The closest point in a box; whether two oriented boxes overlap. |

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
