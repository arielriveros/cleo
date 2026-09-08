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

### Possession and source

| Field | Meaning |
|---|---|
| **Possess** | Which Character this drives. |
| **Source** | **Player**, **AI**, or **None**. |

Everything below Aim is shown only when the source is AI.

### Actions (player source)

**Move**, **Look**, **Jump**, **Sprint**, **Crouch** — these are **action names**, not keys. What
drives them is authored in the [Input panel](input.md), so a player can rebind anything without a
script changing.

### Aim

| Field | Meaning |
|---|---|
| **Aim source** | **Possessed** (walk the pawn for a camera rig), **Node** (a named node), or **World** (yaw 0). |
| **Aim source node** | For the Node option. |
| **Drive the camera rig** | Steer the rig with the look input. On by default. |

Aim source is what makes movement camera-relative: the character's move direction is expressed
relative to the aim yaw.

### Goal

| Field | Meaning |
|---|---|
| **Goal** | One of the [steering verbs](../reference/animation-builtins.md#ai-goals--ai_goals). |
| **Target key** | The blackboard entry holding the target's node id, or the literal `point`. |
| **Goal point** | The fallback position when the target key is `point`. |

A brain overrides this while a state or goal is held; the field is the default and is enough on its
own for a simple agent.

### Steering

`maxSpeed` (3), `arriveRadius` (0.4), `slowRadius` (2.5), `standoff` (2), `wanderRadius` (1.2),
`wanderDistance` (2.5), `wanderJitter` (90°/s).

> **A wandering agent that spins on the spot is turning too fast.** `wander` aims at a point offset
> from current forward, so turning moves the target, which provokes more turning. Measured over 30
> seconds of drift: 220°/s covers 0.9 m, 120°/s covers 0.9 m, 60°/s covers 2.7 m, **30°/s covers
> 12 m**. Chasing has no such loop, so a shambling enemy wants two turn rates — slow while
> wandering, fast while hunting.

### Obstacle avoidance

`avoidDistance` (**0 — off by default**), `avoidStrength` (1.5), `whiskerCount` (3),
`whiskerSpread` (60°, the total fan).

### Perception

| Field | Default | Meaning |
|---|---|---|
| **Field of view** | `120` | The **full** cone, in degrees. 360 is omniscient within range. |
| **Range** | `20` | |
| **Memory span** | `5` | Seconds a lost target is remembered. |
| **Reaction time** | `0.25` | Delay before a visible target counts as *noticed*. |
| **Eye height** | `1.6` | |
| **Auto-acquire** | on | Take the nearest noticed character as the target. |

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

`flockRadius` (6 — **0 disables flocking entirely**), `separationWeight` (1.5), `alignmentWeight`
(1), `cohesionWeight` (0.8). Only the `flock` goal reads these.

### Brain

The slot that links a [`.brain` asset](ai-brains.md). Linked, it shows the brain's name and a
summary (*Behaviour machine · N states* or *Goal graph · N goals*), with ✎ to open it and ✕ to
unlink. Empty, it offers **Use existing…**, **+ Machine**, **+ Goals**, and **Extract to asset**
when there is already something to extract.

## Navigation meshes

Add **Gameplay ▸ Nav Mesh**, size its box, and press **Bake**.

### Bounds

The node's **transform picks what gets baked** — an oriented box, so "navigate this room" is
expressible.

| Field | Meaning |
|---|---|
| **Size X / Y / Z** | Full extents in world units. **`0` on any axis means unbounded — the whole scene.** |
| **Fit to scene** | Sizes and centres the box around everything bakeable, padded by 1 unit per side. |

> The transform picks the bounds; it does **not** move the data. Baked contours are stored in world
> space, so nudging the node cannot invalidate an existing path — it only makes the bake **stale**,
> which the panel warns about.

### Bake settings

| Setting | Default | Meaning |
|---|---|---|
| **Max slope** | `45°` | Steepest walkable incline. |
| **Weld tolerance** | `0.01` | The grid coincident vertices snap to. Load-bearing, not an optimisation — without it, surfaces that visually touch stay disconnected. |
| **Simplify tolerance** | `0.001` | How straight a contour has to be to drop a vertex. |
| **Agent radius** | `0.4` | Pulls the walkable area back from walls. |
| **Include terrain** + **terrain step** | | Whether the heightfield is sampled, and how coarsely. |

**Bake** reports regions, walkable and rejected triangles, colliders, terrains and milliseconds, and
says whether it was clipped to the box or covered the whole scene. **Clear** discards it.

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

Turn on the controller's navmesh routing and use the `path` or `patrol` goal.
`waypointRadius` (0.5) is how close counts as arrived; the repath policy (`interval 0.5`,
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

The Controller inspector also reads out live state — current behaviour state, current goal, the
plan, neighbour count and path remaining — which is usually enough to see what an agent thinks it
is doing.

## See also

[AI brains](ai-brains.md) · [AI (scripting)](../scripting/ai.md) · [Characters and controllers](../scripting/characters-and-controllers.md) · [Night Shift example](../../examples/scripts/NIGHT_SHIFT.md)
