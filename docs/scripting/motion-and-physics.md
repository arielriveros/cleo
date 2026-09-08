# Motion and physics

Bodies, collisions, raycasts, and the difference between what you asked a node to do and what it
actually did.

## Giving a node a body

Usually you do this in the editor's Physics panel ([guide](../editor/physics.md)). From script:

```ts
setBody(
  mass: number,
  linearDamping?: number,
  angularDamping?: number,
  linearConstraints?: [number, number, number],
  angularConstraints?: [number, number, number],
  friction?: number,           // default 0.3
  restitution?: number,        // default 0
  simulatePhysics?: boolean,
  cameraCollision?: boolean,
  groundProbeDistance?: number,
  motionSmoothing?: number,
): RigidBody

get body: RigidBody | null
setTrigger(): Trigger
get trigger: Trigger | null
```

`mass: 0` means static. Friction combines between two bodies with **min**, restitution with
**max** — so one frictionless body is enough to make a contact frictionless, and one bouncy body is
enough to make it bounce.

> `setBody` places the body at the node's **world** position, but `setPosition` writes the node's
> **local** position into the body. A body on a parented node therefore ends up in the wrong place.
> Keep bodied roots at the scene root.

### Shapes

```ts
Shape.Box(w, h, d, scale?)
Shape.Sphere(r, scale?)
Shape.Capsule(r, h, segments, scale?)      // returns { shape, offset }[] — a cylinder plus two caps
Shape.Cylinder(rTop, rBottom, h, segments, scale?)
Shape.Plane()
Shape.ConvexHull(vertices, faces, scale?)  // null if degenerate
Shape.TriMesh(geometry, scale?)
Shape.Heightfield(data, elementSize)

body.attachShape(shape, offset = [0,0,0], orientation = [0,0,0])
```

cannon has no capsule primitive, which is why `Shape.Capsule` returns several pieces.

### Body members worth knowing

```ts
setPosition(p: vec3) ; setQuaternion(q: quat)
originPosition(out: vec3)
recenterMass()
reset()
impulse(impulse: vec3, relativePoint?: vec3 | 0)
get/set simulatePhysics: boolean     // independent of…
get/set cameraCollision: boolean     // …this one
get owner: Node | null
readonly friction / restitution / groundProbeDistance / motionSmoothing
```

`simulatePhysics` and `cameraCollision` are **independent channels**: a decorative bush can be
non-colliding for gameplay yet still push a camera out of it, and a trigger volume can be neither.

> **A collider offset from the mesh moves the centre of mass**, because cannon has no separate
> centre-of-mass concept — `body.position` *is* it. An object whose collider sits off-centre will
> tilt to the ground normal. `recenterMass()` is the fix.

## Commanded motion

```ts
get velocity: vec3 ; set velocity(v)               // fresh vector on each read
get angularVelocity: vec3 ; set angularVelocity(v) // rad/s
```

This is what you asked for. Setting `velocity` every frame is the normal way to move a
script-driven object.

> Never write `velocity` on a `CharacterNode` — its locomotion writes it every frame and the two
> writers fight. See [Characters and controllers](characters-and-controllers.md).

## Measured motion

Derived from where the body actually went. All of these are safe on a node with no body (they read
zero), and all are available to animation and AI parameters as
[built-ins](../reference/animation-builtins.md).

| Member | Type | Meaning |
|---|---|---|
| `currentVelocity` / `rawVelocity` | vec3 | Smoothed / unsmoothed. |
| `currentSpeed` / `rawSpeed` | number | Total magnitude, including falling. |
| `planarSpeed` | number | Perpendicular to gravity. **What a locomotion blend wants.** |
| `verticalSpeed` | number | Signed; positive rising. |
| `currentDirection` / `planarDirection` | vec3 | Hold their last value while still. |
| `planarAngle` | number | Travel direction relative to **facing**, degrees. |
| `worldPlanarAngle` | number | Absolute heading; assignable to `setRotation([0, a, 0])`. |
| `forwardSpeed` / `lateralSpeed` | number | The only **signed** speeds. Positive lateral is **left**. |
| `planarAcceleration` | number | Signed rate of change. |
| `isAccelerating` / `isDecelerating` | boolean | |
| `isMoving` | boolean | With hysteresis. |
| `movingTime` / `stillTime` | number | Seconds, continuous. |
| `turnRate` | number | Degrees per second, wrap-safe. |
| `angularSpeed` | number | rad/s, commanded. |
| `isFalling` | boolean | |
| `airTime` / `groundedTime` | number | Seconds. |

> **This is the distinction that matters.** A character running into a wall keeps its commanded
> `velocity` but reads `planarSpeed ≈ 0`. Bind an animation blend to `planarSpeed` and the
> character drops to idle against the wall; bind it to a script's intended speed and it runs on the
> spot forever.

## Grounding

```ts
get isGrounded: boolean
get groundNormal: vec3
get groundDistance: number    // -1 when unknown; needs groundProbeDistance on the body
get slopeAngle: number        // degrees
```

`isGrounded` is gravity-relative, so it still means the right thing if gravity is not −Y.

> ### `isGrounded` allows a ~0.1 s grace
>
> Not for a gameplay reason: cannon only emits a contact while two shapes actually overlap, so the
> solver pushes a resting body out until the overlap reaches zero, the contact vanishes for a frame,
> gravity presses it back, and it returns. A capsule walking flat terrain loses its contact on about
> 5 frames in 240 that way. The body never left the ground, so `false` on those frames is simply
> the wrong answer. You get coyote-time jumping out of it for free.
>
> Two consequences:
>
> - **It is not "am I falling right now."** It stays true for the grace after you really do walk off
>   a ledge. Use `isFalling` or `velocity[1]` for that.
> - **Never gate movement speed on it.** `const running = sprintHeld && this.isGrounded` looks
>   reasonable and kills air momentum: once airborne past the grace, sprint speed drops to walk
>   speed *mid-jump* and a running jump decelerates in flight. Gate the *animation* on grounded if
>   you like; never the speed.
>
> A character reading `false` for ~0.4 s right after Play starts has not found a bug — it is
> falling. A node 0.8 m above the ground takes 0.4 s to land.

## Collisions and triggers

```ts
onCollision(other: Node): void    // requires a body on BOTH nodes
onTrigger(other: Node): void      // requires a trigger on THIS node
```

```ts
export default class PickupNode extends Node {
  public score: number = 10
  private _taken: boolean = false

  onTrigger(other: Node) {
    if (this._taken) return              // walking back and forth must not double-count
    if (!other.getVariable('isPlayer')) return
    this._taken = true
    const director = this.findNode('GameManager') as any
    director?.addScore(this.score)
    this.despawn()
  }
}
```

The `_taken` latch is not optional: a trigger fires while the overlap persists, not once.

## Raycasting

```ts
scene.physics.raycast(from: vec3, to: vec3, options?: PhysicsRaycastOptions): PhysicsRaycastHit | null

interface PhysicsRaycastHit {
  point: vec3 ; normal: vec3 ; distance: number
  body: RigidBody
  node: Node | null
}

interface PhysicsRaycastOptions {
  checkCollisionResponse?: boolean   // default true
  ignore?: Body | Body[] | null
  includeTriggers?: boolean          // default false
  includeGhosts?: boolean            // default false
  reject?: (owner: Node | null, body: Body) => boolean
}
```

A ground-placement query, which is how the shipped example places spawns:

```ts
public groundAt(x: number, z: number): vec3 | null {
  const hit = this.scene.physics.raycast([x, 200, z], [x, -50, z])
  if (!hit) return null

  // The landscape registers its heightfield directly with the physics world, with no owning node.
  // So a hit that HAS a node came off something else — a roof, a crate — and is not the ground.
  if (hit.node !== null) return null

  // And it has to be walkable, or things spawn on cliffs they can only fall off.
  const up = Math.acos(Math.min(1, Math.abs(hit.normal[1]))) * 180 / Math.PI
  if (up > this.maxSlope) return null

  return hit.point
}
```

`hit.node === null` meaning "this is terrain" is worth remembering — it is the cheapest terrain
test there is.

For scattering points on a disc, use `R * Math.sqrt(u)`, not `R * u`. The latter piles two thirds
of the samples into the middle third of the area.

### Visual raycasting

For picking against render geometry rather than colliders, use `Raycaster` and a node's BVH — see
[Math and utilities](math-and-utils.md#raycasting).

## Physics system

```ts
scene.physics.isGrounded(body, maxSlopeDegrees?, graceSeconds?): boolean
scene.physics.groundNormal(body, maxSlopeDegrees?, graceSeconds?): vec3
scene.physics.groundDistance(body): number
scene.physics.get up: vec3                       // gravity, reversed
scene.physics.motionOf(body): MotionRecord | undefined
scene.physics.airborneTimes(body): { airTime: number, groundedTime: number }
scene.physics.startRagdoll(modelNode, options?): Ragdoll
scene.physics.get/set gravity: [number, number, number]
scene.physics.get stats: PhysicsStats
```

`Game.gravity` is the same value, reachable without going through the scene.

## Ragdolls

```ts
const ragdoll = this.scene.physics.startRagdoll(modelNode, {
  jointType: 'coneTwist',
  coneAngle: 45,
  twistAngle: 90,
  impulse: [0, 1.5, -2],
})
```

`RagdollOptions`: `jointType` (`'ball' | 'coneTwist'`), `coneAngle`, `twistAngle`, `stiffness`,
`angularDamping`, `linearDamping`, `boneMass`, `radiusScale`, `minRadius`, `maxRadius`,
`selfCollision`, `impulse`, `inheritVelocity`.

Starting a ragdoll switches the animator into ragdoll mode; the bones are driven by physics instead
of by clips. This is the usual stand-in for a death animation when you do not have one.

> **Keep the twist limit loose.** cannon's twist constraint jitters when it is tight.

## Character body setup, measured

The shipped third-person character documents this in detail
([README](../../examples/scripts/README.md)); the headline numbers:

| Setting | Value | Why |
|---|---|---|
| Collider | **Capsule** | A box's flat bottom catches on heightfield triangle edges and hops: measured on *perfectly flat* terrain, a box bounced 101 mm at 5 u/s and was grounded on 18 frames out of 240. A capsule bounced 2.5 mm and was grounded 240/240. |
| Friction | **0** | A script sets its own speed, so surface grip only fights it. The default 0.3 eats **26%** of commanded speed, and uphill/downhill differ by **31%**. |
| Mass | 1 | |
| Linear damping | 0 – 0.05 | |
| `linearConstraints` | `[1, 1, 1]` | A locked linear axis silently kills movement along it. This is the usual cause of "movement is dead in some directions". |
| `angularConstraints` | `[0, 0, 0]` | Stops the *solver* tipping the body. It does not stop a script or root motion from rotating it. |

A frictionless character does not slide when idle, because the script zeroes horizontal velocity
when there is no input.

## See also

[Characters and controllers](characters-and-controllers.md) · [Physics (editor)](../editor/physics.md) · [Animation](animation.md)
