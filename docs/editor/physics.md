# Physics

The **Physics** panel, on any selected node. Three collapsible sections: Rigid Body, Trigger, and
Ragdoll — plus the shape list they share.

The runtime side is in [Motion and physics](../scripting/motion-and-physics.md).

## Rigid body

Available on **root-level nodes only**.

| Setting | Meaning |
|---|---|
| **Simulate Physics** | Whether the body collides and responds. |
| **Camera Collision** | Whether a camera rig's spring arm collides with it. **Independent of the above.** |
| **Mass** | `0` is static. |
| **Damping** / **Angular Damping** | Velocity bleed per second. |
| **Friction** | Default `0.3`. Combines between two bodies with **min**. |
| **Restitution** | Bounce. Default `0`. Combines with **max**. |
| **Ground probe** | Distance a downward probe reaches, which is what makes `groundDistance` and `slopeAngle` readable. |
| **Motion smoothing** | Filters the measured speed that feeds animation blends. |
| **Linear constraints** | Per-axis toggles. |
| **Angular constraints** | Per-axis toggles. |

Two independent channels is the useful part: a decorative bush can be non-colliding for gameplay yet
still push the camera out of itself.

> **A bodied node must sit at the scene root.** Adding a body places it at the node's *world*
> position, but writing the node's position afterwards writes its *local* position into the body, so
> a parented body ends up in the wrong place.

> **A locked linear axis silently kills movement along it.** This is the usual cause of "movement is
> janky or dead in some directions" — with Z locked, forward and back do nothing while strafing
> still works.
>
> Locking **angular** stops the physics *solver* tipping or spinning the body on contact. It does
> **not** stop a script or a root-motion clip from rotating it, which is exactly what you want for a
> character.

## Triggers

A trigger detects overlap without responding to collision. Add one, give it shapes, and the node's
`onTrigger(other)` fires while something is inside.

Trigger volumes are drawn in the viewport when the debug eye menu has them on.

> A trigger fires **while** overlapping, not once. Latch it if the thing it does should happen once —
> see [the pickup pattern](../scripting/patterns.md#a-pickup).

## Shapes

Both bodies and triggers take a list of shapes; each has its own offset and rotation.

| Shape | Notes |
|---|---|
| **Box** | |
| **Sphere** | |
| **Capsule** | The right shape for a character. |
| **Cylinder** | |
| **Plane** | An infinite half-space. |
| **Convex hull** | Fitted to the mesh, with a quality ladder and a *Regenerate hull* action. |

Adding a primitive **auto-fits it to the mesh**, including for skinned characters, so you rarely
have to type dimensions.

> ### Use a capsule for characters, not a box
>
> A box's flat bottom catches on the triangle edges of a terrain heightfield and hops. Measured on a
> *perfectly flat* heightfield, walking for four seconds:
>
> | Collider | Speed | Bounce height | Grounded frames |
> |---|---|---|---|
> | box | 5 u/s | **101 mm** | 18 / 240 |
> | box | 9 u/s | **250 mm** | 10 / 240 |
> | capsule | 3–9 u/s | **2.5 mm** | 240 / 240 |
>
> The box is genuinely airborne most of the time, so `isGrounded` is false and jumping barely works.
> A capsule rests on an analytic sphere cap and rolls over the same edges.

> **An offset collider moves the centre of mass**, because the physics engine has no separate
> centre-of-mass concept — the body's position *is* it. An object whose collider sits off-centre will
> tilt to the ground normal.

## Character setup

The measured recommendation, from the [third-person example](../../examples/scripts/README.md):

| | |
|---|---|
| Collider | **Capsule** |
| Mass | `1` |
| **Friction** | **`0`** |
| Linear damping | `0` – `0.05` |
| Linear constraints | `[1, 1, 1]` |
| Angular constraints | `[0, 0, 0]` |

> **Friction 0 is not a hack.** A character's locomotion sets its own speed, so surface grip only
> fights it. The default `0.3` eats **26%** of the commanded speed, and the loss depends which way
> you face:
>
> | Commanded 5 u/s | flat | 10° slope, uphill : downhill |
> |---|---|---|
> | friction 0.3 | 3.70 | 3.68 : 4.83 — **31% apart** |
> | friction 0 | **5.00** | 4.97 : 5.03 — 1% apart |
>
> Slopes split the two directions because running downhill the ground falls away, so the body spends
> a quarter of its frames out of contact and pays no friction, while uphill it pays in full. Terrain
> never has to look sloped for this to bite — the flatten brush approaches its target
> asymptotically and saving quantizes heights, so "flat" terrain still has micro-slopes.
>
> A frictionless character does not slide when idle, because its locomotion zeroes horizontal
> velocity when there is no input.

## Ragdolls

Available on skinned models.

| Setting | Meaning |
|---|---|
| **Joint type** | Ball or Cone-Twist. |
| **Cone angle** / **Twist angle** | Cone-twist limits. |
| **Stiffness** | |
| **Angular / linear damping** | |
| **Bone mass** | |
| **Radius scale** | How thick the per-bone capsules are relative to the bone. |
| **Self collision** | |
| **Knockback impulse** | Applied when the ragdoll starts. |

> **Keep the twist limit loose.** The constraint solver's twist equation jitters when it is tight.

Start one from a script with `scene.physics.startRagdoll(modelNode, options)` — this is the usual
substitute for a death animation.

## Terrain and tilemap collision

Neither needs setting up here.

- A **landscape** registers its heightfield directly with the physics world, with **no owning node**.
  That is what makes `hit.node === null` the cheapest terrain test there is.
- A **tilemap** merges its solid tiles into as few boxes as possible, so a hand-painted floor becomes
  a handful of colliders rather than hundreds.
- **Foliage** colliders are pooled and created near the camera rather than for every instance.

## Seeing colliders

Turn on **Collision wireframes** and **Trigger volumes** in the debug eye menu. Both have separate
Editor and Runtime switches, so you can watch colliders during Play without cluttering authoring.

## See also

[Motion and physics (scripting)](../scripting/motion-and-physics.md) · [Node inspector](node-inspector.md) · [Third-person character](../../examples/scripts/README.md)
