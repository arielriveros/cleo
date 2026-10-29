# AI agents

*Unreleased — these node types landed after v1.1.2.4.*

An agent is a **Character** possessed by a **Controller**. The character moves; the controller
decides. Set the controller's source to Player and it is the player's avatar; set it to AI and the
same character walks itself, with the same animations.

What it decides *with* is a [brain](ai-brains.md). This page is about the agent.

## The hierarchy

Both the player and an enemy are built the same way: the character is the template root, and its
driver is one of its children.

```
Playable <character>                Enemy <character>
├── Camera Rig <cameraRig>          ├── Model <model>
│   └── Camera <camera>             ├── Brain <controller>
├── Model <model>                   │       possesses Enemy
└── Player Controller <controller>
        possesses Playable
```

> **Keep the controller inside the template**, not at the scene root. A placed instance is rebuilt
> with fresh node ids whenever the template changes, and a controller outside the instance keeps
> pointing at the id the character used to have — the agent stops moving, with only a per-frame
> warning to explain it.

> **Keep the controller as the last child.** With aim source *Possessed*, the controller finds the
> camera rig by walking the pawn's children depth-first and taking the first rig it meets — a walk
> that now includes the controller itself. Keeping the rig ahead of it means the rig is found first.

Because a placed template instance is read-only in the scene, changing a controller's actions or aim
source means opening the **template**, not editing in place. The transform stays editable.

## The Controller inspector

The **Controller** section is the driver: it possesses a Character and decides, each frame, what that
character should try to do — from player actions or from a brain. Swapping a player for an AI is
switching **Source**; the character does not change.

### Possession

The Character this controller drives, picked from the scene. With a Character selected in the
hierarchy, **Possess "…"** takes it in one click. One controller can move between pawns, and a second
controller possessing the same pawn takes over: the last possess wins. Until it possesses something, the
controller drives nothing, and the section says so.

### Source

Where the intent comes from. **Player** reads the actions below; **AI** steers itself from its goal and
brain; **None** writes no intent and holds the character still, which is what a cutscene wants. A
script's `onThink(delta)` runs last whatever the source, so it can patch the intent.

Everything below Aim is shown only when the source is AI.

### Actions (player source)

Shown for the Player source: the input action behind each of **Move**, **Look**, **Jump**, **Sprint**
and **Crouch**. These are **action names**, not keys. What drives them is authored in the
[Input panel](input.md), so a player can rebind anything and the controller keeps working. Leave one
empty to leave it unbound.

### Aim

Where movement's "forward" points: the character's move direction is expressed relative to the aim
yaw, which is what makes movement camera-relative.

| Field | Meaning |
|---|---|
| **Basis** | **Camera rig under the pawn** (the first Camera Rig found walking the pawn's children — the usual third-person setup), **A specific node** (picked below it), or **World** (yaw 0, so movement is world-relative — what a top-down game wants). |
| **Drive the camera rig** | Push the look input into that rig. On by default; leave it on unless something else already drives the rig, or the camera turns at double speed. Not shown for World. |

### Goal

Shown for the AI source. The goal is the verb; the blackboard supplies the noun — a script writes
`setBlackboard('target', node.id)`.

| Field | Meaning |
|---|---|
| **Behaviour** | One of the [steering verbs](../reference/animation-builtins.md#ai-goals--ai_goals). **script** writes no intent at all and leaves the frame to `onThink`. |
| **Target key** | The blackboard entry holding the target's node id, or the literal `point`. A key rather than a node field, so "chase whoever is called target" is authored once and works for every copy of an NPC. |
| **Fallback point** | The position used when the target key is `point`. A goal that names a thing and has none holds still rather than walking to the origin. |

A brain overrides this while a state or goal is held; the field is the default and is enough on its
own for a simple agent.

### Steering

How the agent moves toward its goal, shown for every goal but **script**, and only with the fields that
goal reads: `maxSpeed` (3), `arriveRadius` (0.4), `slowRadius` (2.5), `standoff` (2), `wanderRadius`
(1.2), `wanderDistance` (2.5), `wanderJitter` (90°/s).

> **A wandering agent that spins on the spot is turning too fast.** `wander` aims at a point offset
> from current forward, so turning moves the target, which provokes more turning. Measured over 30
> seconds of drift: 220°/s covers 0.9 m, 120°/s covers 0.9 m, 60°/s covers 2.7 m, **30°/s covers
> 12 m**. Chasing has no such loop, so a shambling enemy wants two turn rates — slow while
> wandering, fast while hunting.

### Obstacle avoidance

Fans **Whiskers** rays ahead and steers around what they hit. A **Look ahead** of 0 switches it off
entirely and fires no rays at all; the physics engine has no sphere cast, so a fan of rays is the
approximation available. `avoidDistance` (the look ahead, **0 — off by default**), `avoidStrength`
(1.5), `whiskerCount` (3), `whiskerSpread` (60°, the total fan).

### Perception

What the agent can see and remember. Every field here is a reason an NPC stops being omniscient.

- **Sight** — the cone, the range and the eye height. Range and cone are tested before any
  line-of-sight ray, so a crowd outside the cone costs nothing.
- **Memory** — how long a target is remembered after it was last seen, and how long a visible one
  must stay visible before it counts as *noticed*.

| Field | Default | Meaning |
|---|---|---|
| **Field of view** | `120` | The **full** cone, in degrees, not the half-angle: 120 sees 60° either side of the pawn's facing. 360 sees everything within range. |
| **Range** | `20` | How far the agent can see. |
| **Eye height** | `1.6` | How far above the pawn's origin it looks from. The origin is at the feet, and a ray cast from there runs along the floor, so an agent with no eye height is blind. |
| **Memory span** | `5` | Seconds a lost target is remembered — what makes an agent walk to where you *were*. The `investigate` goal has nothing to act on without it. |
| **Reaction time** | `0.25` | Seconds of continuous visibility before a target counts as *noticed*, so an agent does not react the frame a pixel of you clears a doorway. |
| **Acquire targets automatically** | on | Write the nearest noticed character into the target key. Without it perception fills in the senses but nothing becomes the target, so turn it off only for a brain that picks its own. |

> **Perception does not run while you are authoring.** An enemy standing inert in the viewport is not
> broken — press Play.

> ### There is no faction system
>
> Every Character is a perception candidate for every other, and auto-acquire takes the nearest
> noticed one. Left alone, **your enemies target each other** and the group mills around itself
> while the player walks past untouched.
>
> The fix is to turn auto-acquire **off** and acquire in a script, filtered on a marker variable the
> player sets on itself. See [the worked example](../scripting/ai.md#perception).

### Flocking

Separation, alignment and cohesion over the other Characters nearby. Only the `flock` goal reads
these, so set **Behaviour** (or a brain's state or goal) to `flock` for them to do anything.
`flockRadius` (the **Neighbour radius**, 6 — **0 disables flocking entirely** and skips the neighbour
scan), `separationWeight` (1.5), `alignmentWeight` (1), `cohesionWeight` (0.8).

### Brain

The slot that links a [`.brain` asset](ai-brains.md). Linked, it shows the brain's name and a
summary (*Behaviour machine · N states* or *Goal graph · N goals*), with ✎ to open it and ✕ to
unlink. Empty, it offers **Use existing…**, **+ Machine**, **+ Goals**, and **Extract to asset**
when there is already something to extract; a brain dragged from the Assets panel links too. With
no brain, the **Goal** section above is in charge.

## Navigation meshes

The walkable surface AI pathfinds over, baked from the scene's colliders and terrain inside the
node's box. Add **Gameplay ▸ Nav Mesh**, size its box, and press **Bake**.

In the viewport a navmesh is selected by its green icon, at the node's position. Clicking anywhere
else inside its box (the landscape it covers) selects what you clicked, not the navmesh. It can also be
selected from the scene tree.

### Bounds

The node's **transform picks what gets baked** — an oriented box, so "navigate this room" is
expressible.

| Field | Meaning |
|---|---|
| **Size** | Full extents in world units, X / Y / Z. Drag and scale the node to place the box; while it is selected the box is outlined and every walkable surface inside it is painted cyan, which is exactly what a bake would keep. **`0` on any axis means unbounded — the whole scene.** |
| **Fit** | Sizes and centres the box around everything bakeable, padded by 1 unit per side. |

> The transform picks the bounds; it does **not** move the data. Baked contours are stored in world
> space, so nudging the node cannot invalidate an existing path — it only makes the bake **stale**,
> which the panel warns about.

### Bake settings

What the bake reads, and how it turns that into a surface.

**Bake** — builds the surface from the scene's **colliders** and terrain, never its render meshes: an
invisible collider blocking a corridor has no mesh, a LOD group holds three copies of one floor, and a
skinned mesh contributes a bind pose, so reading colliders makes the bake agree with the physics. It
reports regions, walkable and rejected triangles, colliders, terrains and milliseconds, and says
whether it was clipped to the box or covered the whole scene. **Clear** discards it.

| Setting | Default | Meaning |
|---|---|---|
| **Max slope** | `45°` | Steepest incline an agent will walk. Anything steeper is a wall — including, deliberately, the underside of everything, because a ceiling is a floor with its normal reversed. |
| **Weld** | `0.01` | The grid nearby vertices snap to before surfaces are linked. Load-bearing, not an optimisation: two surfaces join only where their shared edge matches exactly, so without it a hairline seam between meshes becomes two disconnected islands and every path across it fails. |
| **Simplify** | `0.001` | How straight a contour has to be to drop a vertex. |
| **Agent radius** | `0.4` | Clearance: carving pads every obstacle by it, and paths keep it off the corners they hug. |
| **Carve obstacles** | on | Cuts static solids — walls, pillars, buildings, trunks — out of the floor, padded by the agent radius, so paths go around them instead of through (see below). |
| **Agent height** | `1.8` | Headroom, shown while carving is on. Something higher than this above the floor, such as a lintel or a bridge, does not carve the floor under it. |
| **Terrain** | on, `1/2` | Whether terrain heightfields are sampled, and the sample step. `1` is every vertex — far more detail than a planar navmesh can use, and a 129² terrain is 32,768 triangles. Not saved with the node. |

The step height (`stepHeight`, `0.3`) is stored with the bake but has no row: an obstacle that rises
less than this above the floor is stepped over, not carved around.

### Obstacle carving

Without carving, the floor under a wall, a pillar or a building stays walkable. Paths then run
straight through solids, and only steering avoidance keeps agents off them. With **Carve obstacles**
on, the bake removes every floor point that has something solid within **agent radius** of it,
between **step height** and **agent height** above it. Heights are measured from the floor's own
slope, so:

- a ramp does not carve itself, or the floor at its foot,
- a ledge does not eat the top of the ramp that climbs it.

What carves:

- **Static colliders** of any shape, spheres and capsules included.
- **Collidable foliage instances** inside the volume, such as tree trunks, posed exactly as their
  physics bodies.

What does not carve:

- **Dynamic bodies** (mass above 0), which move away from where they were baked.
- **Ghosts** (`simulatePhysics: false`).
- **Any node with a boolean variable `navObstacle` set to `false`.** Use this for a gate or door that
  opens, or its route stays closed for good.

> Surfaces that **overlap** without sharing an edge are separate islands. A ramp lying on a floor is
> one example, and the bake does not stitch them. Model the junction so the two meet along an edge.

> ### The bake reads colliders, not render meshes
>
> A beautifully modelled staircase with no collider is not walkable, and a plain box collider under
> a detailed rock *is*. If a bake comes back empty or with a surprising shape, look at the collision
> wireframes, not at the geometry.

### The preview

While a navmesh node is selected you get two overlays:

- a **wireframe box** showing the bake volume — cyan when bounded, dimmed and covering the whole
  level when unbounded,
- a **cyan translucent surface** showing what is currently walkable.

The preview runs the **same walkability test the bake does**, so it cannot disagree with the result.
Above a triangle cap it switches off and the panel says how many triangles it skipped — the box is
still drawn.

The separate **Navigation mesh** entry in the debug eye menu controls the *baked* wireframe, which
is independent of this selection-time preview.

### Using it

Give the controller the `path` or `patrol` goal: it paths on the scene's first baked navmesh, with
nothing to wire up. `waypointRadius` (0.5) is how close counts as arrived; the repath policy (`interval 0.5`,
`targetDrift 1.5`) decides when to recompute.

> `path` and `patrol` **fall back to their straight-line equivalents** with no baked navmesh, so a
> level is playable before you bake and simply gets better afterwards. Bake late.

**Routes** are named point lists on the node, for `patrol`. **Off-mesh links** connect two points
that are not walkably adjacent — a jump, a ladder.

## Debugging an agent

| Symptom | Usual cause |
|---|---|
| Does nothing in the viewport | Perception is skipped while authoring. Press Play. |
| Enemies ignore the player and mill about | No faction system — auto-acquire is taking the nearest *enemy*. |
| Notices you instantly through a wall | Gating on raw visibility rather than *noticed*, or the range and cone are too generous. |
| Forgets you the instant you round a corner | The target is being dropped the moment line of sight breaks. Hold it until the memory span lapses. |
| Walks straight into geometry | No baked navmesh, so `path` fell back to a straight line. |
| Spins on the spot while wandering | Turn speed too high — see the table above. |
| Stops moving after the template changed | The controller is outside the instance and is possessing a stale id. |

A controller also exposes its live state to scripts — `behaviorState`, `goalState`, `goalPlan`,
`neighborCount` and `pathRemaining` — and logging those from `onThink` is usually enough to see what
an agent thinks it is doing.

## See also

[AI brains](ai-brains.md) · [AI (scripting)](../scripting/ai.md) · [Characters and controllers](../scripting/characters-and-controllers.md) · [Valley example](../../examples/scripts/SOULS_DEMO.md)
