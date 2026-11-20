# Physics

Physics in a scene is made of nodes, both in the Add catalog's [Simulation](scene-authoring.md#simulation)
category and edited in Properties:

- a **Collider** is a rigid body: its shapes are what collides, and everything under it moves with it;
- a **Trigger** is a sensor: it detects what comes in and goes out, and stops nothing.

A skinned model's **Ragdoll** is a section of that model's own Properties.

The runtime side is in [Motion and physics](../scripting/motion-and-physics.md).

## Collider

What makes something solid: a body the physics solver moves (or holds still, at mass `0`), and the
shapes it collides with. Put what it is made of under it. A crate is a Collider with the crate's model
as its child; give the Collider mass and the crate falls, its model with it. A whole house can stand in
one Collider holding its wall boxes.

| Setting | Meaning |
|---|---|
| **Simulate Physics** | Whether the body collides and responds. A body that does not still blocks a camera rig, and rays can still hit it. |
| **Mass** | `0` is static. |
| **Damping** / **Angular Damping** | Velocity bleed per second. |
| **Friction** | Default `0.3`. Combines between two bodies with **min**. |
| **Restitution** | Bounce. Default `0`. Combines with **max**. |
| **Ground probe** | Distance a downward probe reaches, which is what makes `groundDistance` and `slopeAngle` readable. |
| **Motion smoothing** | Filters the measured speed that feeds animation blends. |
| **Simulation** | How far from the camera the body keeps simulating before it freezes in place: **Project range** (the range in Options ▸ Engine ▸ Runtime), **Always** (never frozen) or **Custom range** (its own, in metres). See [Simulation range](#simulation-range). |
| **Sleep when resting** | Sleeps once the body stops moving, until it is hit, pushed or a script sets its velocity. Off by default. A body sleeps together with every moving body it touches, so a stack of crates goes to sleep as one once the whole stack has settled. |
| **Layer** | The collision layer it is on, one of the project's 16. Default: **Default**. A camera rig decides by it whether the body blocks its boom or is seen through, and foot IK which layers its feet land on. See [Layers](#layers). |
| **Collides with** | The layers it collides with. Default: all. |
| **Linear constraints** | Per-axis toggles. |
| **Angular constraints** | Per-axis toggles. |

What a camera does with the body is not set here. Each camera rig picks the layers that block it and the
ones it sees through (see [Camera Rig](node-inspector.md#cameras)), so the body only has to be on the
right layer. A decorative bush can be non-colliding for gameplay and still push the camera out of itself.

> **What is under a Collider, and what it is under.** A body lives in world space, and a Collider may sit
> anywhere in the tree:
> - Everything under it moves with it. A Collider inside another one is a body of its own: a door in a
>   wall, a crate on a cart.
> - A **static** Collider (mass `0`) follows its parent. Move or turn the group it is in and the collider
>   moves with it, as a door on a moving platform should.
> - A **dynamic** Collider is moved by physics in world space; its local pose is worked out from that
>   under whatever parent it has. Moving the parent afterwards does not drag a falling crate along, as
>   in other engines.
> - A non-uniformly scaled ancestor is not supported: physics shapes cannot be sheared.

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

### Layers

A project has 16 collision layers, the same for its 3D and its 2D physics (a [2D body](tilemap-2d.md#2d-physics)
picks from the same names). Name them in **Options ▸ Project ▸ Layers**; an unnamed one shows as
*Layer N*. The first four are the engine's, and their names are fixed:

| Layer | Name | What uses it |
|---|---|---|
| 1 | **Default** | Everything that does not say otherwise, and every body the engine makes itself: a landscape, the ground plane, tilemaps, foliage without a layer. |
| 2 | **Ragdoll** | Ragdoll bones. They collide with every layer but their own. |
| 3 | **See Through** | What a new camera rig sees through: its boom passes, and the meshes of Colliders on it are dithered away where they block the view. |
| 4 | **No Camera** | What a new camera rig ignores: small props and debris that should not pull the camera in. |

Two Colliders collide only when each one's **Collides with** holds the other's **Layer**: `(A.layer &
B.mask) && (B.layer & A.mask)`. Name layer 5 *Projectiles*, put the player's projectiles on it, and leave
it out of the player's own **Collides with**: the player never shoots itself. A Trigger's **Layer** and
**Detects** work the same way.

The same layers choose what queries react to:

- a [camera rig](node-inspector.md#cameras) is **Blocked by** some layers and **Sees through** others;
- a [foot IK rig](animation.md#foot-placement)'s **Trace layers** are the layers its feet land on;
- a script's raycast takes a `layerMask` (see [Motion and physics](../scripting/motion-and-physics.md)).

That is how stairs are built: an invisible ramp for the character's capsule on a layer only characters
collide with, and the steps on a layer the capsule's **Collides with** leaves out. The body glides up the
ramp, while the foot IK traces land on the treads and leave the ramp out. The
[Sandbox example](sandbox-example.md) builds its stairs this way.

### Events

`onCollision(other)` fires on the **Collider** itself, with the other Collider (or the Trigger, or a
landscape's `null`). A script that should hear its body's hits goes on the Collider, or reads
`this.collider` from a node under it. Nothing bubbles up or down the tree.

### Projects from before

A project saved when a body was a property of any node converts as it loads:

- an **empty node** with a body becomes the Collider itself, and one with only a trigger the Trigger: same
  name, script and children, so its script still hears its own collisions and triggers;
- **any other node** with a body (a model, a character, a placed model) is wrapped in a new Collider named
  `<name> Collider`, which takes its place and transform; the node keeps its name, scripts and children;
- a trigger beside a body, or on a node that is not empty, becomes a `<name> Trigger` child;
- an Area 2D becomes a Trigger.

A placed template's root that is wrapped hands its link to the template to the Collider. Save the scene
to keep the converted form.

Camera settings from before rigs chose layers convert as they load too:

- a Collider with **Camera Collision** off moves to **No Camera**;
- a Collider marked **See-through to camera**, or holding a mesh that was, moves to **See Through**;
- a rig in *Dither* mode is blocked by every layer but See Through and No Camera, and sees through See
  Through. A rig in *Retract* mode is blocked by every layer but No Camera, and sees through nothing.

Only a Collider on **Default** moves; one on a layer of its own keeps it. A mesh marked see-through with no
Collider round it can no longer be cut. Put it in a Collider on See Through.

## Trigger

A Trigger node detects overlap without responding to collision. Give it shapes, and its
`onTriggerEnter(other)` / `onTriggerExit(other)` fire as things come and go (on the Trigger, and on the
Collider or Trigger that came in), and `onTrigger(other)` on first contact. Under a Collider, a Trigger
rides with it: a character's hurtbox.

In a **2D scene** the same node is a 2D trigger: a box (**Size** and **Offset**, mirrored when the
character it rides on faces left) that sees 2D bodies, Collider 2Ds and other triggers on the layers it
looks for. See [2D physics](tilemap-2d.md).

By default a trigger detects moving bodies (characters, props). Turn on **Detect triggers** and it also
detects other triggers: a weapon's hitbox entering a character's hurtbox, both triggers.

| Setting | What it does |
|---|---|
| **Enabled** | Whether the trigger detects anything. A disabled trigger keeps its shapes but physics, overlap queries and the overlay ignore it; switching it on costs nothing. Scripts switch it with `trigger.enabled`. |
| **Detect triggers** | Also detect other trigger volumes. Only one side of a pair has to have it on. Plain zones leave it off. |
| **Continuous** | Test the volume along its path from last frame to this one against other triggers, so a fast mover (a blade) cannot skip past a thin target between two frames. Needs **Detect triggers** on one side. |
| **Layer** | The collision layer this trigger is on. In a 2D scene, the 2D world's layer bits. |
| **Detects** | The layers it detects. A pair only overlaps when each side's **Detects** has the other's **Layer**. A hurtbox that detects only the hitbox layer never even reaches a contact test with its own character's body. |

Trigger volumes are drawn in the viewport when the debug eye menu has them on. While the game runs (Play
or Simulate) the overlay draws what physics is actually testing, including triggers scripts create:
green for a zone, cyan for one that detects triggers, magenta for a continuous one, yellow while it
overlaps something. A disabled trigger disappears on the frame it is switched off.

> `onTrigger` fires on every new contact — walk out and back in and it fires again. Latch it if the
> thing it does should happen once — see [the pickup pattern](../scripting/patterns.md#a-pickup).

## Shapes

A Collider and a 3D Trigger take a list of shapes; each has its own offset and rotation, in the node's
own space. **Add** puts a box, sphere, capsule, cylinder or plane on the list, fitted to the meshes
under the node, and **Add Convex Hull** fits one to them at the chosen **Hull Definition**. A Trigger
with no mesh under it fits the node it is under.

**Meshes** — which of the meshes under the node a convex hull is built from, as a tree of their nodes with a
checkbox each; shown when there is more than one. Ticking a node ticks everything under it, and a node with only
some of it ticked shows part-way. All are ticked to start with. A hull keeps the meshes it was built from, by their
nodes' names (so they hold in every placed copy of a template), and its own Meshes on its row rebuild it from
others: a car's body and windows without its wheels, a door frame without the door.

| Shape | Notes |
|---|---|
| **Box** | |
| **Sphere** | |
| **Capsule** | The right shape for a character. Its **Total Height** spans the caps too, so the straight section is height − 2 × radius; at or below 2 × radius it is a sphere. |
| **Cylinder** | |
| **Plane** | An infinite half-space, facing its own +Z. Drawn as a 4 m grid with a short stub along that normal. |
| **Convex hull** | Fitted to the mesh's vertices, at a **Definition** from Low (exactly the bounding box, 6 faces) to Very High (up to 50 faces). Every level encloses the whole mesh, so a lower one is looser, never tighter. Changing a hull's Definition or its **Meshes** rebuilds it in place, from the meshes it was built from, and keeps the rotation you gave it. Not offered on skinned meshes. |

**Shape** — one collider on the list, titled by its type and place ("Box 2"): its dimensions, an
**Offset** and a **Rotation** in the node's own space. Clicking the title selects the shape for editing
in the viewport (see below); the arrow folds the row away. The frame button selects it and moves the
camera to it, ✕ removes it, and the **⋯** menu holds the rest:

| Action | What it does |
|---|---|
| **Duplicate** | A copy right after it, selected. |
| **Move up / Move down** | Reorders the list. Only the order you read it in changes. |
| **Fit to mesh** | Re-sizes the shape to the meshes under the node along the shape's *own* axes, keeping its rotation, so a box turned to lie along a beam fits the beam. Not for planes or hulls. |
| **Convert to …** | The same space as another primitive: a box becomes the sphere around it, a cylinder the capsule of its radius and length. Offset and rotation are kept. |

Sizes never go below 1 mm and segment counts below three. Every edit in the list is one undo step,
including a whole drag of a number field.

Adding a primitive **auto-fits it to the mesh**, including for skinned characters, so you rarely
have to type dimensions, and selects it, so its handles are up straight away.

### Editing shapes in the viewport

With a Collider or a Trigger selected, each of its shapes shows a small dot at its centre: red on a
Collider, green on a Trigger. Click a dot, or a row's title in its inspector, to select that shape. Its wireframe turns
orange, the node's other shapes fade, and the viewport edits the shape instead of the node:

- **Square handles** sit on both faces of every axis the shape can be sized along: all six faces of a
  box, the radius of a sphere in every direction, and the radius and length of a capsule or cylinder.
  Dragging one moves that face alone. The opposite face stays put and the offset follows. A readout
  shows the size in metres as you drag. A handle on a face turned away from you is drawn faded.
  - Hold **Alt** to grow both sides at once about the centre.
  - Hold **Ctrl** to snap the size to the translate step set in Options ▸ Editor ▸ Viewport.
- **Move (W)** and **Rotate (E)** drive the shape's **Offset** and **Rotation** with the usual gizmo,
  whose local axes are now the shape's own. The node's own gizmo is hidden meanwhile.
- **Escape** during a drag puts the shape back as it was. With no drag, Escape, clicking elsewhere, or
  selecting any node goes back to editing the node.

Each drag is one undo step, and the inspector shows the new values as you drag. Handles follow the
node's scale and rotation exactly as the physics does. On a non-uniformly scaled node, that means a
sphere grows with the largest axis, and a capsule or cylinder grows radially with the larger of X and Z.

The handles are not shown in Play or Simulate, on a placed template instance (which is read-only here),
or for a channel whose wireframes are switched off in the debug eye menu. A convex hull and a plane can
be moved and rotated but not sized: a hull's size is its Definition, and a plane has no size.

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

A Character has no shape of its own: it stands in a Collider, which holds its capsule and is what
moves. The Character's locomotion drives that Collider's body, and its `velocity`, `isGrounded` and the
rest read it:

```
Player Collider      Collider: capsule, mass 1, friction 0, angular constraints off
└─ Player            Character
   ├─ Knight         the model
   └─ Controller
```

A Character that is not in a Collider cannot move, and the Console says so. **Add ▸ Gameplay ▸ Character**
makes both, set up as below.

From a script, `teleport(position, yaw)` moves a character's whole body (its Collider). A character
template's root is its Collider, so `scene.instantiate('Hollow')` returns the Collider and `.character` is
the Character in it.

The measured recommendation for the Collider, from the [third-person example](../../examples/scripts/README.md):

| | |
|---|---|
| Shape | **Capsule** |
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
> A frictionless character does not slide when idle on the flat, because its locomotion zeroes horizontal
> velocity when there is no input. On a slope it is the Character's **Slope Limit** (45 degrees) that holds
> it: up to that steep, gravity only presses it into the ground, so it stands still on a ramp and brakes and
> climbs as on the flat. See [Characters and controllers](../scripting/characters-and-controllers.md#acceleration-on-slopes).

### What a lighter body can do to a character

A character is not pushed about by bodies lighter than it. A body lighter than the character can stop it
and hold it up: you can stand on a crate, land on it and jump off it. But it can move the character only by
its share of the two masses. A crate of 8 kg against a 75 kg character gives about a tenth of the push the
solver gave.

- Jumping into the edge of a light box does not throw the character up it.
- A light box that tips under the character does not lift it on its corner.
- A light ball thrown at the character barely moves it.

The crate still gets the whole push, so the character shoves it along as before. Bodies at least as heavy
as the character, static and kinematic bodies, the ground and walls are unaffected. A fixed edge still
deflects a capsule up, as its round bottom meets it.

The rule compares masses, so give the character's Collider its real mass. A character of 1 kg (the
recommendation above, and what **Add ▸ Gameplay ▸ Character** makes) is lighter than any prop, and every
prop can still push it. The Sandbox's character is 75 kg.

One limit: a light body that is itself carried up by something heavier (a crate on a lift) does not lift a
character standing on it either.

## Cloth on a character

A skinned model can carry cloth parts of its own — a surcoat's skirt, a loincloth, a tabard — that swing
with the body instead of following the bones stiffly. They are vertices of the model itself: each one is
pulled to where the skin puts it, with some slack, and the slack grows from where the cloth is sewn on
(none: it stays put) to its hem (up to the model's **max distance**, a quarter of a metre or so). It never sinks
more than a **backstop** behind where the skin holds it, and capsules fitted to the armour (else the
ragdoll's) keep it outside the legs. The scene's
[Wind](node-inspector.md#wind) blows it. The model also sets how heavy the cloth is: its **mass** (heavier
cloth is moved less by the wind) and a **gravity scale** (above 1 it falls and settles harder).

It simulates while the scene plays (Play and Simulate); while you edit, the model shows its bind shape.
Which vertices are cloth, and how free each one is, is stored with the model (`skinnedCloth`) and
painted in the model's [Cloth](models-and-materials.md#cloth) section: open the model, turn on **Paint**,
and brush the parts that should move. For a
separate panel — a banner, a flag, a cape — add a [Cloth](node-inspector.md#effects) node instead.

## Ragdoll

How a skinned model falls when a script turns it into a ragdoll, with
`scene.physics.startRagdoll(modelNode, options)` — the usual substitute for, or ending to, a death
animation. It is the skeleton's: authored in its [Ragdoll panel](#the-ragdoll-panel-rig-editor), with only
a character's mass and push in its Properties (the Skeleton section's
[This character](node-inspector.md#this-character) rows).

**Source** — which of three ragdolls the character falls with, decided by its rig:

| Source | When | What it is |
|---|---|---|
| **Rig profile** | Its rig has parts authored in the rig editor's **Ragdoll** panel | Exactly what was authored: shaped body parts, real masses, knees and elbows that only bend one way. |
| **Automatic humanoid** | No authored parts, and the skeleton has recognizable hips and legs | 16 body parts fitted to the bones. Open the rig to see the parts or customize them. |
| **Generic** | Anything else | A sphere on every substantial bone. Authoring parts on the rig gives a better fall. |

The humanoid ragdoll (authored or automatic) is built per body *segment*, not per bone:

- pelvis, spine and chest; head; upper arms, forearms and hands; thighs, shins and feet;
- capsules and boxes along each segment, sized from the bones;
- masses from human segment proportions, 70 kg by default;
- knees and elbows are **hinges** that only bend one way;
- the other joints are cones centred on a natural resting direction, so an arm bound in a T-pose rests lower;
- limbs collide with each other and with the torso.

A character's own settings, in its Properties:

- **Ragdoll mass** — multiplies the profile's total mass. A generic ragdoll has no profile, so it has no
  mass scale either.
- **Ragdoll push** — a velocity, in m/s, added to the upper body as it starts falling, in the character's
  own frame (left, up, forward). A negative forward value topples it backwards. On a generic ragdoll it is
  the knockback impulse on its root bone.

A generic ragdoll's joints (ball or cone-twist, damping, bone mass, radius) keep what earlier projects stored
on the node, but are no longer edited there: author parts on the rig instead.

### The Ragdoll panel (rig editor)

The **Ragdoll** tab beside a skeleton's inspector — in the [Skeleton part](animation.md#the-skeleton-part)
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
  (`physics/pal/cannon/heightfieldCollision.ts` replaces cannon's own heightfield resolvers for this.)

## Seeing colliders

Turn on **Collision wireframes** and **Trigger volumes** in the debug eye menu. Both have separate
Editor and Runtime switches, so you can watch colliders during Play without cluttering authoring. At
runtime the trigger overlay is live: it follows every trigger in the physics world, as described under
[Trigger](#trigger).

## See also

[Motion and physics (scripting)](../scripting/motion-and-physics.md) · [Node inspector](node-inspector.md) · [Third-person character](../../examples/scripts/README.md)
