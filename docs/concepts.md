# Core concepts

The vocabulary every other page uses, and the one thing worth understanding early: the order in
which things happen inside a frame.

## Project

A **project** is one game. It owns scenes, assets, an input map, render settings and editor
preferences, and it is completely isolated from every other project — storage keys, dock layouts
and libraries are all namespaced. You can have many, and switching between them reloads the editor.

A project is exported as a single `.zip` and imported the same way. See
[Projects](editor/projects.md).

## Scene

A **scene** is a tree of nodes with a single invisible root. One scene in a project is the **main
scene**, which is where a published game starts; scripts can switch to any other scene at runtime
with `Game.loadScene(name)`.

A scene is authored as either **3D** or **2D**. The choice is not cosmetic: it decides whether you
get the Landscape or the Tilemap editor, and a published build discards the authoring data for the
dimension it is not using. See [Scene settings](editor/scene-authoring.md#scene-settings).

## Node

A **node** is one thing in the scene: a mesh, a light, a camera, a sound emitter, a UI element, an
empty pivot. Every node has

- a name and a stable id,
- a transform (position, rotation in **degrees**, scale) relative to its parent,
- children,
- optionally a rigid body, a trigger volume, an animator, a script.

Node types are a fixed set of 30 classes — see [Node types](reference/node-types.md). A plain
`Node` (called **Empty** in the editor) is a perfectly good thing to build with: it has a
transform, it can carry a script, and it can parent other nodes.

Nodes are addressed by name or id (`findNode('Player')`, `scene.getNodeById(id)`), never by path.

## Asset

An **asset** is a reusable piece of content stored in the project's library rather than inside a
scene: a model, a material, a texture, a script, a tileset, an animation clip, an AI brain. Assets
live in a virtual folder tree you browse in the **Assets** panel, and several nodes can reference
the same asset — editing a material updates every node that uses it.

There are 14 asset kinds; see [Assets](editor/assets.md) for what each one is and how it is created.

## Template

A **template** (a prefab) is a saved node subtree. Drag it into a scene to place an instance;
change the template and every placed instance is rebuilt. Anything inside a placed instance is
**read-only in the scene** except its transform — to change it, open the template itself.

Templates are also how you spawn things at runtime: `scene.instantiate('Zombie', { position })`.

## Script

A **script** is a TypeScript class that *extends a node type* and is attached to a node:

```ts
import { Node, Logger } from 'cleo'

export default class DoorNode extends Node {
  public openSpeed: number = 2      // becomes an editable field on the node

  onStart() { Logger.log('door ready', 'Script') }
  onUpdate(delta: number) { /* … */ }
}
```

Public class fields become per-node values you can edit in the inspector without touching code, so
one script can drive many nodes with different settings. See
[Getting started](scripting/getting-started.md).

## Play mode

**Play** swaps the scene you are editing for a live copy and runs it: physics steps, scripts run,
input is read, AI perceives. **Stop** throws that copy away and returns you to the scene you were
editing — changes made while playing are not kept.

Two things behave differently while merely authoring, and both surprise people:

- **AI perception does not run.** An agent standing still in the viewport is not broken; press Play.
- **Spawn rules do not apply.** A node marked "spawn on start" is visible while authoring.

## Editor mode

The editor is always in one **mode**, which decides what the viewport is for and which panels are
visible. Five modes are chosen from the top bar (Scene, Landscape/Tilemap, UI, Renderer, Input);
the rest are entered by opening an asset — opening a material puts you in Material mode, opening a
script puts you in Script mode. See [Editor modes](editor/modes.md).

## Editor-only nodes

The grid, light icons, collision wireframes, camera frustums and the navmesh preview are real
nodes in the scene, flagged `editorOnly`. They are never serialized, never lit, never shadowed, and
they are structurally absent from a published build. You control them from the eye menu in the
viewport — see [Debug overlays](editor/scene-authoring.md#debug-overlays).

---

## The frame

Understanding this order resolves most "why is my camera a frame behind" questions. Every frame,
`Scene.update` does the following, in this order:

1. **Transforms.** The whole tree's world matrices are recomputed from the root.
2. **Timers.** `after` and `every` callbacks that came due are run.
3. **Perception.** Every AI controller senses the world. *Skipped while paused or authoring.*
4. **Control.** Every controller writes an intent into the character it possesses — **before** any
   script's `onUpdate`. This is what lets a character act on *this* frame's camera aim.
5. **Node loop.** Nodes marked for removal are unlinked, input actions are dispatched to nodes that
   handle them, then every node's `update` runs — which is where your `onUpdate` is called.
6. **Dormant sweep.** Nodes that despawned this frame leave the active sets.
7. **Camera rigs.** Transforms are recomputed *again*, then every camera rig places its camera.
   This is why a rig-driven camera never trails its target by a frame.
8. **Audio.** The listener is placed from the active camera and every spatial emitter is synced, so
   both ends are sampled at one instant.
9. **UI layout.** Screen rectangles are solved. A value your script wrote in `onUpdate` is on
   screen the same frame, not the next one.

Physics steps separately, driven by the engine, and writes results back into node transforms.

> **Game time is not wall-clock time.** The per-frame delta is clamped to `0.333s`, so a tab left
> in the background does not resume with a single enormous step that tunnels every body through the
> floor. The two clocks diverge permanently after that; use `Game.time` when you need "how long has
> this game been running".

## Coordinate and sign conventions

| | |
|---|---|
| Handedness | Y is up. A node's local forward is **+Z**. |
| Rotations | **Degrees**, composed `Rz · Ry · Rx`. The gimbal singularity is at **yaw ±90°**, not pitch. |
| Angles | **Counter-clockwise.** Strafing right is **−90°**, left is **+90°**, backwards is ±180°. |
| Lights | Photometric: directional lights are in **lux**, point and spot lights in **lumens**. |

The angle convention is forced by the yaw maths (`atan2(x, z)`) and is the one place people most
often get a mirrored result. Forward and backward still look correct when you have it backwards,
which is what makes it hard to spot — see [Characters and controllers](scripting/characters-and-controllers.md).

## See also

[Editor guide](editor/README.md) · [Scripting guide](scripting/README.md) · [Glossary](reference/glossary.md)
