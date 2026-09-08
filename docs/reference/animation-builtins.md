# Reference — built-ins, senses, goals and conditions

The vocabularies shared by the animation state machine and the AI behaviour machine: values you can
bind a parameter to, the conditions you can gate a transition on, and the steering verbs an agent
can be asked to perform.

---

## Node built-ins — `NODE_BUILTINS`

Values the engine **measures** off a node, available to an animation parameter (Built-in → Self /
Parent / Scene) and to a behaviour parameter (`{ kind: 'builtin' }`). They exist as a curated list
because they are prototype getters, which the ordinary own-property lookup used for node variables
cannot see.

They are all also readable from script as plain properties — see
[Measured motion](../scripting/motion-and-physics.md#measured-motion).

| Name | Type | Signed | Meaning |
|---|---|---|---|
| `currentSpeed` | number | | Total speed, smoothed. Includes falling. |
| `rawSpeed` | number | | The same, unsmoothed. |
| `planarSpeed` | number | | Speed perpendicular to gravity. **This is what a locomotion blend wants** — it ignores falling, so a jump never reads as a sprint. |
| `verticalSpeed` | number | ✔ | Positive rising. |
| `planarAngle` | number | ✔ | Direction of travel relative to **facing**, in degrees. `0` ahead, `−90` right, `+90` left, `±180` back. |
| `worldPlanarAngle` | number | ✔ | Absolute heading. Assignable straight into `setRotation([0, a, 0])`. |
| `forwardSpeed` | number | ✔ | Signed component along facing. |
| `lateralSpeed` | number | ✔ | Signed sideways component. **Positive is LEFT.** |
| `planarAcceleration` | number | ✔ | Rate of change of planar speed. |
| `isAccelerating` | boolean | | |
| `isDecelerating` | boolean | | |
| `isMoving` | boolean | | With hysteresis, so it does not chatter at the threshold. |
| `movingTime` | number | | Seconds moving continuously. |
| `stillTime` | number | | Seconds still continuously. |
| `turnRate` | number | ✔ | Degrees per second, wrap-safe. |
| `angularSpeed` | number | | Magnitude of angular velocity, rad/s. Not signed — it is a hypotenuse, so it has no direction to be negative about. |
| `isGrounded` | boolean | | See [the grace period](../scripting/motion-and-physics.md#grounding). |
| `isFalling` | boolean | | |
| `airTime` | number | | Seconds since leaving the ground. |
| `groundedTime` | number | | Seconds since landing. |
| `groundDistance` | number | | `−1` when unknown. Requires a ground probe distance on the body. |
| `slopeAngle` | number | | Degrees. |

> **Only the signed ones can go below zero.** A state's Speed parameter clamps at 0, so a blend-space
> sample authored at a negative coordinate on an unsigned axis is simply unreachable — the probe can
> never get there. This is the usual cause of "one of my clips never plays".
>
> The two valid 2D locomotion layouts are `forwardSpeed × lateralSpeed` (signed, non-wrapping) or
> `planarAngle × planarSpeed` (a wrapping direction axis against an unsigned magnitude). Mixing them
> puts samples where the probe cannot reach.
>
> `planarAcceleration`, `isAccelerating` and `isDecelerating` are rates rather than states, and they
> are what make **start** and **stop** animations expressible at all: speed alone cannot tell a
> character breaking into a run from one already running.

---

## Behaviour senses — `BEHAVIOR_SENSES`

Values a **behaviour machine** or a **goal evaluator** can read that only the controller knows.
Selected with `{ kind: 'sense' }`.

| Sense | Meaning |
|---|---|
| `distanceToTarget` | Straight-line distance to the blackboard target. |
| `angleToTarget` | Degrees between facing and the target. |
| `hasTarget` | Whether the target key resolves to anything. |
| `targetVisible` | A bare line-of-sight test. Kept for compatibility. |
| `stateTime` | Seconds in the current behaviour state. |
| `hasPath` | Whether a navmesh route is currently held. |
| `pathRemaining` | Distance still to **walk**. |
| `targetInSight` | Line of sight **with** the cone, the range and the reaction delay. |
| `timeSinceSeen` | `0` while visible, `Infinity` if never seen. |
| `lastKnownDistance` | Distance to where the target was last seen. |
| `neighborCount` | Agents inside the flock radius. |

> Prefer `pathRemaining` over `distanceToTarget` for anything about approach. A straight line says a
> wall is one metre away when the way around it is thirty.
>
> Prefer `targetInSight` over `targetVisible`. The bare test has no cone, no range and no reaction
> delay, so an agent using it notices you instantly, through the back of its head.

## Behaviour parameter types

`BEHAVIOR_PARAM_TYPES = ['number', 'boolean', 'trigger']`.

A **parameter source** (`BehaviorParameterSource`) says where a value comes from:

| `kind` | Reads |
|---|---|
| `const` | A literal. |
| `builtin` | A [node built-in](#node-built-ins--node_builtins). |
| `variable` | A node variable. |
| `blackboard` | A numeric or boolean blackboard entry. |
| `sense` | A [behaviour sense](#behaviour-senses--behavior_senses). |
| `fuzzy` | An output of the brain's fuzzy model. |

---

## AI goals — `AI_GOALS`

The steering verbs. A behaviour state or a goal-graph leaf names one.

| Goal | Behaviour |
|---|---|
| `idle` | Stand still. |
| `seek` | Head straight at the target. |
| `flee` | Head straight away. |
| `arrive` | Approach and slow into `arriveRadius`. |
| `follow` | Keep `standoff` distance from a moving target. |
| `wander` | Drift, steering toward a point offset from current forward. |
| `path` | Walk a navmesh route to where `seek` would have gone straight. |
| `patrol` | Walk a route authored on the navmesh. |
| `investigate` | Walk to where the target was **last seen**. |
| `flock` | Separation, alignment and cohesion over nearby agents. |
| `script` | Write no intent at all — leave the frame to `onThink`. |

> `path` and `patrol` **fall back to their straight-line equivalents** when the scene has no baked
> navmesh, so adding one to an unbaked scene is never a regression. Bake, and the same agent starts
> going around things.
>
> `investigate` is the behaviour the whole memory system exists for: it is the difference between an
> agent that loses you the instant you round a corner and one that comes looking.

> **A wandering agent that spins on the spot is not broken, it is turning too fast.** `wander` aims
> at a point offset from current forward, so turning moves the target, which provokes more turning.
> Measured over 30 seconds of drift: 220°/s covers 0.9 m, 120°/s covers 0.9 m, 60°/s covers 2.7 m,
> **30°/s covers 12 m**. Chasing has no such loop — the target is a place in the world — so a
> shambling agent wants two turn rates, a slow one for wandering and a fast one for pursuit.

---

## Conditions — `CONDITION_OPS`

Shared by animation transitions and behaviour transitions.

```ts
type ConditionOp = 'gt' | 'lt' | 'eq' | 'neq' | 'true' | 'false' | 'trigger'

interface Condition {
  param: string
  op: ConditionOp
  value?: number     // threshold for gt / lt / eq / neq
  band?: number      // latching hysteresis band, centred on the threshold
}
```

Conditions combine into a tree of `and` / `or` groups (`ConditionGroup`), which is what the
editor's condition-tree widget builds.

### The latching band

Every `gt` / `lt` condition can carry a **band**, and on anything measured it is not optional.

A measured value is never perfectly still. A bare `Speed > 0.1` leaving Idle and a bare
`Speed < 0.1` leaving Locomotion are each obviously correct on their own, and together they are the
single most common way to make a character vibrate: a speed hovering at `0.1` satisfies both on
alternating frames, so the machine flips state every frame and re-arms a cross-fade from a pose
that has barely moved.

With `± 0.1`, `> 0.1` does not engage until `0.15` and `< 0.1` not until `0.05`, so the signal has
to genuinely swing before the machine moves. The editor flags a `>` / `<` pair whose engage points
do not separate, and the runtime logs `Animation state machine is ping-ponging: …` naming the two
states if one slips through.

`minDwell` on the transition is the blunter alternative and also works.

## See also

[Animation (editor)](../editor/animation.md) · [Animation (scripting)](../scripting/animation.md) · [AI (scripting)](../scripting/ai.md) · [AI brains (editor)](../editor/ai-brains.md)
