# AI

*Unreleased — the controller, navmesh and brain system landed after v1.1.2.4.*

An agent is a [Character](characters-and-controllers.md) possessed by a `ControllerNode` whose
source is AI. The controller senses the world, decides on a goal, and turns that goal into steering.
You author the decision-making in the editor ([AI brains](../editor/ai-brains.md)) and reach into it
from script when you need something the authored model cannot express.

## The frame, for an agent

1. **Perception pass** — `controller.perceive(delta)` for every AI controller. *Skipped while
   paused or while merely authoring.*
2. **Control pass** — `controller.think(delta)`:
   1. resolve the possessed pawn (no pawn → return),
   2. compute the aim basis,
   3. refresh the fuzzy model, step the brain, convert the desired velocity into an intent,
   4. drive the aim rig,
   5. publish the intent,
   6. **`onThink(delta)` last**.
3. **Node loop** — everyone's `onUpdate`.

> Because `onThink` runs after everything else in the control pass, it *patches* an already-complete
> intent rather than competing with one. Pair it with `goal: 'script'`, which writes no intent at
> all while keeping possession, the aim basis and obstacle avoidance.

## Where the decision-making lives

`behavior`, `goals` and `fuzzy` are **fields on the controller** and are the runtime source of
truth; they travel inside the serialized scene. A `.brain` asset is an authoring convenience —
editing one pushes a fresh copy into every controller that links it, and `brainId` records only
where the copy came from.

Consequences worth knowing:

- Unlinking a brain changes no behaviour.
- Deleting the asset does not lobotomise agents.
- A published game ships **no brain library** at all.
- A script may read and write `controller.behavior` / `.goals` / `.fuzzy` directly.

`brain` selects which of them decides: `'machine'` (default), `'goal'`, or `'none'` for an agent
driven entirely from `onThink`.

## Goals

The steering verbs are listed in [AI goals](../reference/animation-builtins.md#ai-goals--ai_goals).
Set one directly for a simple agent:

```ts
this.goal = 'wander'
this.goal = 'arrive' ; this.targetKey = 'target'
```

A behaviour state's `goal` and `targetKey` **override** the node's while that state is held.

## The blackboard

A runtime key/value store, and how goals find their targets.

```ts
getBlackboard(key: string): BlackboardValue | undefined     // number | boolean | string
setBlackboard(key: string, value: BlackboardValue | undefined): void   // undefined deletes
clearBlackboard(): void
get blackboardKeys: string[]
get goalTarget: Node | null
```

`targetKey` names an entry holding a **node id string** — or the literal `'point'`, which uses
`goalPoint` instead.

> The blackboard is **never serialized**. Values you want to author belong in node variables.

## Perception

```ts
perception: PerceptionTuning     // { fieldOfView, range, memorySpan, reactionTime }
eyeHeight: number = 1.6
autoAcquire: boolean = true
get sightings: Sighting[]
get lastKnownPosition: vec3 | null

interface Sighting {
  id: string
  visible: boolean
  noticed: boolean
  timeSinceSeen: number          // 0 while visible, Infinity if never seen
  lastKnownPosition: vec3
}
```

Defaults: `fieldOfView: 120` (the **full** cone, in degrees; 360 is omniscient within range),
`range: 20`, `memorySpan: 5`, `reactionTime: 0.25`.

Candidates are **every other `CharacterNode` in the scene**. Range and cone are rejected first, so a
line-of-sight raycast is only spent on candidates actually in front.

> **Gate on `noticed`, not `visible`.** `visible` is raw line of sight; `noticed` is what survives
> the reaction delay. An agent gating on `visible` sees you instantly, the moment you clear a
> corner.

> ### There is no faction system
>
> Every character is a perception candidate for every other, and `autoAcquire` takes the nearest
> noticed one. Left alone, your enemies target **each other** and the group mills around itself
> while the player walks past.
>
> The fix is to turn `autoAcquire` off and acquire in `onThink`, filtered on a marker variable:

```ts
import { ControllerNode, Node } from 'cleo'

export default class EnemyBrainNode extends ControllerNode {
  public targetMarker: string = 'isPlayer'

  onThink(delta: number) {
    const key = this.targetKey
    const held = this.getBlackboard(key)
    const heldId = typeof held === 'string' && held ? held : null

    const self = this.possessed ? this.possessed.worldPosition : this.worldPosition
    let bestId: string | null = null
    let bestDistance = Infinity
    let heldRemembered = false

    for (const sighting of this.sightings) {
      const candidate = this.scene?.getNodeById(sighting.id)
      if (!candidate || !candidate.getVariable(this.targetMarker)) continue

      if (sighting.id === heldId && sighting.timeSinceSeen <= this.perception.memorySpan) {
        heldRemembered = true
      }
      if (!sighting.noticed) continue

      const p = candidate.worldPosition
      const d = Math.hypot(p[0] - self[0], p[1] - self[1], p[2] - self[2])
      if (d < bestDistance) { bestDistance = d; bestId = sighting.id }
    }

    if (bestId) { this.setBlackboard(key, bestId); return }
    // Nothing in sight: hold the last target until its memory lapses, then forget it.
    if (heldId && !heldRemembered) this.setBlackboard(key, undefined)
  }
}
```

Matching on a **variable** rather than a name means renaming the player cannot silently blind every
enemy.

Keeping a target after line of sight breaks is what makes `investigate` mean anything — drop it the
frame you round a corner and the agent forgets you instantly, which is the behaviour the memory
span exists to prevent.

## Steering

```ts
steering: SteeringTuning
whiskerCount: number = 3        // rays cast ahead for obstacle avoidance
whiskerSpread: number = 60      // total fan, degrees
```

`STEERING_DEFAULTS`: `maxSpeed: 3`, `arriveRadius: 0.4`, `slowRadius: 2.5`, `standoff: 2`,
`wanderRadius: 1.2`, `wanderDistance: 2.5`, `wanderJitter: 90` (deg/s), `separationRadius: 1.5`,
**`avoidDistance: 0`** (avoidance is off by default), `avoidStrength: 1.5`.

`steeringTuning()` enforces `slowRadius >= arriveRadius + 0.01` and clamps the rest.

The functions themselves are exported and usable on their own: `seek`, `flee`, `arrive`, `pursue`,
`followTarget`, `wander`, `separate`, `align`, `cohere`, `avoidObstacles`, `blendSteering`,
`intentFromDesired`. `avoidObstacles` takes caller-supplied `ProbeHit`s, so it does not care where
your world queries come from.

> **A wandering agent that spins on the spot is turning too fast**, not malfunctioning. See the
> measured turn-rate table in [AI goals](../reference/animation-builtins.md#ai-goals--ai_goals).
> Chasing has no such feedback loop, so a shambling agent wants two rates — slow while wandering,
> fast while pursuing.

## Flocking

```ts
flockRadius: number = 6         // 0 disables flocking entirely
separationWeight: number = 1.5
alignmentWeight: number = 1
cohesionWeight: number = 0.8
get neighborCount: number       // computes on read
```

Only the `flock` goal reads these.

## Navigation

```ts
get/set navMeshId: string | null    // null = the scene's first baked navmesh
routeName: string
repath: RepathPolicy               // { interval: 0.5, targetDrift: 1.5 }; 0 disables either trigger
waypointRadius: number = 0.5
get path: Readonly<NavPath>
get pathRemaining: number          // computes on read
```

Use the `path` goal to walk around geometry to where `seek` would have gone straight, or `patrol`
to follow an authored route.

> `path` and `patrol` **fall back to their straight-line equivalents** with no baked navmesh, so a
> level is playable before you bake and simply gets better afterwards.

Direct queries, when you want a route without a goal:

```ts
scene.ai?.findPath(source, from: vec3, to: vec3, out?: vec3[]): vec3[]
scene.ai?.navMeshFor(id: string)
scene.ai?.get hasNavigation: boolean
```

> **`scene.ai` is genuinely optional** — it is `undefined` on any scene never handed to the AI
> system. Always guard it.

Path queries are **pull-based**: there is deliberately no per-frame AI pass, so a thousand idle
agents cost nothing in navigation.

The `CleoNavMesh` itself:

```ts
findPath(from: vec3, to: vec3, out?: vec3[]): vec3[]
clampMovement(from: vec3, to: vec3, out: vec3): boolean
contains(point: vec3): boolean
randomPoint(out: vec3): vec3
setLinks(links: OffMeshLink[]): void
get regionCount / nodeCount / edgeCount / links
```

Path helpers, if you drive movement yourself: `createNavPath`, `setNavPath`, `clearNavPath`,
`hasPath`, `currentWaypoint`, `onFinalWaypoint`, `advancePath`, `followPath`, `insetCorners`,
`remainingDistance`, `shouldRepath`, `markRepathed`.

`insetCorners(path, radius, up)` pulls a route away from corners by the agent's radius, which is
what stops a wide agent clipping a wall it technically has a path through.

## Behaviour machines from script

```ts
get behaviorState: string       // '' when there is none
```

The data model is plain and serializable:

```ts
interface BehaviorState { name; goal: AiGoal; targetKey?; speedScale?; isEntry?; x?; y? }
interface BehaviorTransition { from; to; condition?: ConditionGroup; minDwell? }
interface BehaviorMachine { parameters; states; transitions }
```

A machine only evaluates transitions leaving the state it is currently in, which is what keeps
layered machines predictable.

## Goal graphs from script

```ts
get goalState: string
get goalPlan: string[]          // outermost first
```

```ts
interface GoalDefinition {
  name: string
  goal: AiGoal              // the verb a LEAF drives; ignored for a composite
  targetKey?: string
  speedScale?: number
  subgoals?: string[]       // present => composite; run in order
  until?: ConditionGroup    // completed once met
  failWhen?: ConditionGroup // failed once met -> popped, parent replans
}

interface DesirabilityDefinition {
  goalName: string
  source: BehaviorParameterSource
  from: number              // value mapping to desirability 0
  to: number                // value mapping to 1; to < from INVERTS ("nearer is better")
  bias: number
}

interface GoalGraph { goals; evaluators; arbitrationInterval: number }   // default 0.5
```

`arbitrationInterval` governs **abandoning** a plan partway. A plan that finishes always
re-arbitrates immediately regardless. Every frame (`0`) is rarely what you want — it flickers
between near-equal goals.

A goal with no evaluator can only run as a subgoal; it can never be chosen.

## Fuzzy logic

```ts
fuzzyValue(name: string): number      // 0 when there is no model or no such output
```

Inputs are resolved **by name**, in this order: a behaviour sense → a numeric or boolean property on
the pawn (the motion built-ins) → a numeric or boolean blackboard entry. An unmatched name is never
fed, and its rules see the bottom of the range — which is why the editor flags variables that match
no known input.

```ts
const brain = FuzzyBrain.from(model)
brain.set('distance', 12)
const out = brain.evaluate({ distance: 12, health: 0.3 })   // Record<string, number>
```

Set shapes: `triangular`, `leftShoulder`, `rightShoulder`, `leftSCurve`, `rightSCurve`, `normal`,
`singleton`. Term operators: `is`, `and`, `or`, `very` (concentration), `fairly` (dilation).

Defuzzification is `'maxav'` (average of set peaks weighted by firing strength — cheap, jumpier) or
`'centroid'` (integrates the output surface — smoother, roughly 20× the work).

## Readouts for debugging

```ts
get behaviorState / goalState / goalPlan / neighborCount / pathRemaining / sightings
```

All safe to read from a HUD script. `pathRemaining` and `neighborCount` compute on read, so read
them once per frame rather than per use.

## See also

[AI brains (editor)](../editor/ai-brains.md) · [AI agents (editor)](../editor/ai-agents.md) · [Characters and controllers](characters-and-controllers.md) · [Night Shift example](../../examples/scripts/NIGHT_SHIFT.md)
