# Cleo Engine documentation

Cleo is a WebGL2 / WebGPU game engine with an integrated editor. You build a game by assembling a
**scene** out of **nodes** in the editor, attaching **scripts** written in TypeScript, and
publishing the result as a self-contained web page or desktop application.

**Engine version:** v1.1.2.4 — see the [changelog](../CHANGELOG.md)
([release notes](https://github.com/arielriveros/cleo/releases/tag/v1.1.2.4))

> These pages describe the **current source**, which is ahead of the v1.1.2.4 tag. Features that
> landed after it are marked *unreleased* where they appear: the `Character` / `Controller` node
> pair, the `NavMesh` node with its bake-bounds volume, and the **AI Brain** asset with the
> Behaviour / Goals / Fuzzy graph editors. The published-game player contract is at **7** on this
> branch; the last tagged release shipped 6.

---

## Where to start

If you have never opened the editor, read [Core concepts](concepts.md) first. It is short, and
every other page assumes its vocabulary — scene, node, asset, template, script, play mode, and the
order things happen in a frame.

After that the two halves are independent, and you can read either first:

| | |
|---|---|
| **[Editor guide](editor/README.md)** | What every mode, panel and workflow does. Read this to author scenes, import models, paint terrain, rig animation, build UI and publish. |
| **[Scripting guide](scripting/README.md)** | How to write game code. Read this to make things move, react, spawn, score and end. |
| **[Reference](reference/node-types.md)** | Exhaustive tables: every node type, every export, every render setting, every input binding. Look things up here rather than reading it through. |

## The editor guide

| Page | Covers |
|---|---|
| [Interface](editor/interface.md) | Menu bar, tabs, the dockable panel layout, keyboard shortcuts |
| [Editor modes](editor/modes.md) | All 17 modes, how each is entered and what it shows |
| [Projects](editor/projects.md) | Multiple projects, examples gallery, importing and exporting a project |
| [Assets](editor/assets.md) | The asset explorer and all 14 asset kinds |
| [Scene authoring](editor/scene-authoring.md) | The hierarchy, the Add catalog, gizmos, templates, undo, debug overlays |
| [Node inspector](editor/node-inspector.md) | Every property editor, by node type |
| [Models and materials](editor/models-and-materials.md) | Importing meshes, retargeting animation, LODs, the material editor, textures |
| [Physics](editor/physics.md) | Rigid bodies, triggers, colliders, convex hulls, ragdolls |
| [Animation](editor/animation.md) | Clips, state machines, blend spaces, foot IK, events, root motion |
| [AI brains](editor/ai-brains.md) | The `.brain` asset and the Behaviour / Goals / Fuzzy canvases |
| [AI agents](editor/ai-agents.md) | The Controller node, perception, steering, navmesh baking |
| [Terrain](editor/terrain.md) | Landscapes, sculpting, painting, foliage |
| [Tilemaps and 2D](editor/tilemap-2d.md) | 2D scenes, tilesets, tile painting, sprites |
| [UI](editor/ui.md) | Screen and world canvases, anchors, widgets, touch controls |
| [Input](editor/input.md) | Action maps, bindings, processors, rebinding |
| [Audio](editor/audio.md) | Sound samples, emitters, buses, effects |
| [Rendering](editor/rendering.md) | Every render setting, debug channels, the performance HUD |
| [Scripting workflow](editor/scripting-workflow.md) | Script assets, the code editor, editing in VS Code |
| [Publishing](editor/publishing.md) | Exporting a playable game |

## The scripting guide

| Page | Covers |
|---|---|
| [Getting started](scripting/getting-started.md) | What a script is and how it attaches to a node |
| [Lifecycle](scripting/lifecycle.md) | Every hook, its ordering, timers, spawning and despawning |
| [Node API](scripting/node-api.md) | Transforms, hierarchy, lookups, variables |
| [Motion and physics](scripting/motion-and-physics.md) | Bodies, velocity, measured motion, raycasts, collisions |
| [Input](scripting/input.md) | Reading actions |
| [Characters and controllers](scripting/characters-and-controllers.md) | The pawn/driver split, locomotion, camera rigs |
| [AI](scripting/ai.md) | Goals, behaviour machines, fuzzy logic, perception, pathfinding |
| [Animation](scripting/animation.md) | Driving the animator from code |
| [UI](scripting/ui.md) | Building and updating interfaces |
| [Scene and game](scripting/scene-and-game.md) | Spawning, templates, switching scenes, the event bus |
| [Audio](scripting/audio.md) | Playing sound |
| [Rendering](scripting/rendering.md) | Materials, lights, cameras, post-processing from code |
| [Terrain and tilemaps](scripting/terrain-tilemap.md) | Querying and editing at runtime |
| [Math and utilities](scripting/math-and-utils.md) | Vectors, easing, raycasting, logging |
| [Patterns](scripting/patterns.md) | Common recipes, and a consolidated list of gotchas |

## Reference

| Page | Covers |
|---|---|
| [Node types](reference/node-types.md) | Every node class and its API |
| [API index](reference/api-index.md) | Every export of the `cleo` module |
| [Input bindings](reference/input-bindings.md) | Key codes, buttons, axes, gestures, the default map |
| [Animation built-ins](reference/animation-builtins.md) | Values you can bind an animation or AI parameter to |
| [Render settings](reference/render-settings.md) | Every field, type and default |
| [File formats](reference/file-formats.md) | Asset extensions, project bundles, published builds |
| [Glossary](reference/glossary.md) | Terms used throughout |

## Worked examples

Two longer documents ship with the engine's example scripts and are worth reading once you have
something moving. They are written against real, working scenes:

- [Third-person strafe character](../examples/scripts/README.md) — a complete character: camera-relative
  movement, a blend-space locomotion set, turn-in-place, and the physics setup that makes it feel
  right. Includes measured numbers for friction, collider shape and grounding.
- [Night Shift](../examples/scripts/NIGHT_SHIFT.md) — a complete small game assembled from those
  parts: a day/night clock, zombie AI with real sight cones, pickups, powerups, a HUD and an end
  screen.

## A note on what these docs are

Every signature, default and string literal here is taken from the engine source rather than
paraphrased. Where a rule is surprising, the reason is given — most of the surprising rules exist
because the obvious alternative was tried and produced a bug that was hard to see.
