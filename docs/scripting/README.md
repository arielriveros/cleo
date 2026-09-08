# Scripting guide

How to write game code for Cleo. Scripts are TypeScript classes that extend a node type and are
attached to nodes in the editor; public fields become values you can tune per node without touching
code.

Read [Getting started](getting-started.md) first — it is short and everything else assumes it.

## Pages

| Page | Covers |
|---|---|
| [Getting started](getting-started.md) | What a script is, how it attaches, what you may and may not write |
| [Lifecycle](lifecycle.md) | Every hook, when it runs, timers, spawning and despawning |
| [Node API](node-api.md) | Transforms, hierarchy, finding nodes, variables, visibility |
| [Motion and physics](motion-and-physics.md) | Bodies, velocity, measured motion, grounding, raycasts, collisions, ragdolls |
| [Input](input.md) | Reading actions |
| [Characters and controllers](characters-and-controllers.md) | The pawn/driver split, locomotion, camera rigs |
| [AI](ai.md) | Goals, behaviour machines, fuzzy logic, perception, pathfinding |
| [Animation](animation.md) | Driving the animator, parameters, events, blend spaces, IK |
| [UI](ui.md) | Building and updating interfaces from code |
| [Scene and game](scene-and-game.md) | Spawning, templates, switching scenes, the event bus |
| [Audio](audio.md) | Playing sound |
| [Rendering](rendering.md) | Materials, lights, cameras, post-processing |
| [Terrain and tilemaps](terrain-tilemap.md) | Querying and editing at runtime |
| [Math and utilities](math-and-utils.md) | Vectors, easing, raycasting, logging |
| [Patterns](patterns.md) | Recipes, and a consolidated list of gotchas |

## The shortest useful script

```ts
import { Node, Logger } from 'cleo'

export default class SpinnerNode extends Node {
  /** Degrees per second. Editable per node in the inspector. */
  public speed: number = 90

  onStart() {
    Logger.log(this.name + ' spinning', 'Script')
  }

  onUpdate(delta: number) {
    this.rotateY(this.speed * delta)
  }
}
```

## Six things that will save you an afternoon

1. **Transform getters return live objects.** `node.position`, `worldPosition`, `getBoundingBox()`
   and `node.children` are rewritten in place. Copy them if you need to keep a value across frames.
2. **`velocity` is what you asked for; `planarSpeed` is what happened.** A character jammed against
   a wall still has its commanded velocity but reads a measured speed near zero.
3. **Angles are counter-clockwise.** Strafing right is `−90`, left is `+90`.
4. **`isGrounded` has a ~0.1 s grace.** It is not "am I falling right now" — use `isFalling` or
   `velocity[1]` for that. Never gate movement *speed* on it.
5. **Rotations are in degrees**, and compose `Rz · Ry · Rx`, so the gimbal singularity is at
   **yaw ±90°**.
6. **Timers die with their node.** A "give this back in 8 seconds" timer scheduled on the pickup
   that just removed itself never runs.

The full list is in [Patterns](patterns.md#gotcha-index).

## See also

[Core concepts](../concepts.md) · [Editor guide](../editor/README.md) · [API index](../reference/api-index.md)
