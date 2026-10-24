# Physics

The **Physics** panel, on any selected node. Three collapsible sections: Rigid Body, Trigger, and
Ragdoll — plus the shape list they share.

The runtime side is in [Motion and physics](../scripting/motion-and-physics.md).

## Rigid body

What makes the node solid: a body the physics solver moves (or holds still, at mass `0`), and the
shapes it collides with. Available on **root-level nodes only**.

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
| **Simulation** | How far from the camera the body keeps simulating before it freezes in place: **Project range** (the range in Options ▸ Engine ▸ Runtime), **Always** (never frozen) or **Custom range** (its own, in metres). See [Simulation range](#simulation-range). |
| **Sleep when resting** | Sleeps once the body stops moving, until it is hit, pushed or a script sets its velocity. Off by default. |
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

### Simulation range

A large level does not need to simulate the barrel two kilometres behind the camera. Past its range a
dynamic body is **frozen in place**:

- it stays in the world, so rays, the camera boom, triggers and other bodies still hit it;
- it is not integrated and is not tested against terrain or other static geometry;
- when the camera comes back it carries on with the velocity it had, so something mid-fall resumes the fall.

The project's range is **Options ▸ Engine ▸ Runtime ▸ Simulation range** (`0` = simulate everything, the
default). A body's **Simulation** setting picks that range, **Always** (never frozen — the player, or
anything a far-away script depends on) or its own **Custom range**. Distance is measured from the active
camera: the game camera in Play, the editor camera in Simulate.

> A frozen character keeps reporting `isGrounded` as it did when it froze, so it never plays a fall.
> Its script still runs and may still write a velocity; that does not thaw it. A hit or an impulse does.

The Performance panel's **· dynamic** row shows how many bodies are active, frozen and resting.

## Trigger

A trigger detects overlap without responding to collision. Add one, give it shapes, and the node's
`onTriggerEnter(other)` / `onTriggerExit(other)` fire as things come and go (on both nodes of the
overlap), and `onTrigger(other)` on first contact. A node can have a body and a trigger at once.

Trigger volumes are drawn in the viewport when the debug eye menu has them on.

> `onTrigger` fires on every new contact — walk out and back in and it fires again. Latch it if the
> thing it does should happen once — see [the pickup pattern](../scripting/patterns.md#a-pickup).

## Shapes

Both bodies and triggers take a list of shapes; each has its own offset and rotation. **Add** puts a
box, sphere, capsule, cylinder or plane on the list, and **Add Convex Hull** fits one to the mesh at the
chosen **Hull Definition**.

| Shape | Notes |
|---|---|
| **Box** | |
| **Sphere** | |
| **Capsule** | The right shape for a character. Its **Total Height** spans the caps too, so the straight section is height − 2 × radius; at or below 2 × radius it is a sphere. |
| **Cylinder** | |
| **Plane** | An infinite half-space. |
| **Convex hull** | Fitted to the mesh's vertices, at a **Definition** from Low (exactly the bounding box, 6 faces) to Very High (up to 50 faces). Every level encloses the whole mesh, so a lower one is looser, never tighter. Changing a hull's Definition rebuilds it in place and keeps the rotation you gave it. Not offered on skinned meshes. |

**Shape** — one collider on the list, titled by its type: its dimensions, an **Offset** and a
**Rotation** in the node's own space, and **Remove**.

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

## Ragdoll

How a skinned model falls when a script turns it into a ragdoll, with
`scene.physics.startRagdoll(modelNode, options)` — the usual substitute for, or ending to, a death
animation. The section appears on skinned models only.

**Source** — which of three ragdolls the character falls with, decided by its rig. The fields below it
change with the source, and **Edit ragdoll in rig** opens the rig whenever the model has one.

| Source | When | What it is |
|---|---|---|
| **Rig profile** | Its rig has parts authored in the rig editor's **Ragdoll** panel | Exactly what was authored: shaped body parts, real masses, knees and elbows that only bend one way. |
| **Automatic humanoid** | No authored parts, and the skeleton has recognizable hips and legs | 16 body parts fitted to the bones. Open the rig to see the parts or customize them. |
| **Generic** | Anything else | A sphere on every substantial bone, tuned by the fields in this section. Authoring parts on the rig gives a better fall. |

The humanoid ragdoll (authored or automatic) is built per body *segment*, not per bone:

- pelvis, spine and chest; head; upper arms, forearms and hands; thighs, shins and feet;
- capsules and boxes along each segment, sized from the bones;
- masses from human segment proportions, 70 kg by default;
- knees and elbows are **hinges** that only bend one way;
- the other joints are cones centred on a natural resting direction, so an arm bound in a T-pose rests lower;
- limbs collide with each other and with the torso.

Its node settings:

- **Mass Scale** — multiplies the profile's total mass.
- **Push** — a velocity, in m/s, added to the upper body as it starts falling, in the character's own
  frame (left, up, forward). A negative forward value topples it backwards.

The generic ragdoll has its own fields instead: the joint type (a free, stable ball, or a cone-twist
with cone and twist limits and a stiffness), damping, bone mass and radius scale, self collision, and a
knockback impulse applied to its root bone in world space.

### The Ragdoll panel (rig editor)

The **Ragdoll** section of a skeleton's inspector — the [Skeleton part](animation.md#the-skeleton-part)
of its animation workspace — says how characters on that skeleton fall when they die: which bones
become bodies, how big and heavy each is, and how each joint bends. Until parts are authored, it shows
the automatic humanoid profile (or says the skeleton falls with the generic one) read-only.

- **Customize** copies the automatic profile onto the rig so its parts can be edited. **Reset to auto**
  drops it again.
- Each part has:
  - a bone and the bone it ends at;
  - a shape, size and share of the mass;
  - a joint: cone (swing, twist, aim) or hinge (bend range, **Flip bend direction**).
- The viewport draws every collider (cyan) and every joint limit (yellow) on the preview character in its
  current pose. Clicking a bone opens the part on it.
- **Test drop** drops the preview character onto a floor so you can see the fall. **Reset pose** brings it
  back.

Every model on the rig falls with the saved profile, in scenes, templates and the published game.

> **Keep twist limits loose.** The constraint solver's twist equation jitters when it is tight.

## Terrain and tilemap collision

Neither needs setting up here.

- A **landscape** registers its heightfield directly with the physics world, with **no owning node**.
  That is what makes `hit.node === null` the cheapest terrain test there is.
- A **tilemap** merges its solid tiles into as few boxes as possible, so a hand-painted floor becomes
  a handful of colliders rather than hundreds.
- **Foliage** colliders are pooled and created near the camera rather than for every instance.
- Terrain contacts only ever look at the cells a body overlaps, and a cell whose height range the body
  cannot reach is skipped before anything is built. Rays walk only the cells the segment crosses.
  (`physics/heightfieldCollision.ts` replaces cannon's own heightfield resolvers for this.)

## Seeing colliders

Turn on **Collision wireframes** and **Trigger volumes** in the debug eye menu. Both have separate
Editor and Runtime switches, so you can watch colliders during Play without cluttering authoring.

## See also

[Motion and physics (scripting)](../scripting/motion-and-physics.md) · [Node inspector](node-inspector.md) · [Third-person character](../../examples/scripts/README.md)
