# Editor guide

The Cleo editor is where a game is assembled: scenes, models, materials, terrain, animation, AI, UI,
audio and the published build. This guide covers what every mode, panel and workflow does.

If you are new, read [Core concepts](../concepts.md) first, then
[Interface](interface.md) and [Editor modes](modes.md).

## Pages

### Getting around

| Page | Covers |
|---|---|
| [Interface](interface.md) | Menu bar, document tabs, the dockable panel layout, keyboard shortcuts, the console |
| [Editor modes](modes.md) | All 17 modes, how each is entered, which panels it shows |
| [Projects](projects.md) | Multiple projects, the examples gallery, importing and exporting |
| [Assets](assets.md) | The asset explorer and all 14 asset kinds |

### Building a scene

| Page | Covers |
|---|---|
| [Scene authoring](scene-authoring.md) | The hierarchy, the Add catalog, gizmos, templates, undo, debug overlays |
| [Node inspector](node-inspector.md) | Every property editor, by node type |
| [Models and materials](models-and-materials.md) | Importing meshes, retargeting animation, LODs, materials, textures |
| [Physics](physics.md) | Rigid bodies, triggers, colliders, convex hulls, ragdolls |
| [Terrain](terrain.md) | Landscapes, sculpting, painting, foliage |
| [Tilemaps and 2D](tilemap-2d.md) | 2D scenes, tilesets, tile painting, sprites |
| [UI](ui.md) | Screen and world canvases, anchors, widgets, touch controls |
| [Audio](audio.md) | Sound samples, emitters, buses, effects |

### Behaviour

| Page | Covers |
|---|---|
| [Animation](animation.md) | Clips, state machines, blend spaces, foot IK, events, root motion |
| [AI brains](ai-brains.md) | The `.brain` asset and the Behaviour / Goals / Fuzzy canvases |
| [AI agents](ai-agents.md) | The Controller node, perception, steering, navmesh baking |
| [Input](input.md) | Action maps, bindings, processors, rebinding |
| [Scripting workflow](scripting-workflow.md) | Script assets, the code editor, editing in VS Code |

### Look and ship

| Page | Covers |
|---|---|
| [Rendering](rendering.md) | Every render setting, debug channels, the performance HUD |
| [Publishing](publishing.md) | Exporting a playable game |

## A first pass through the editor

A rough order that gets you from an empty project to something playable, with each step producing
something you can look at:

1. **Create a project** and choose whether its first scene is 3D or 2D
   ([Projects](projects.md), [Scene settings](scene-authoring.md#scene-settings)).
2. **Block out the level** with primitives and complex shapes from the Add catalog, or paint a
   landscape ([Scene authoring](scene-authoring.md), [Terrain](terrain.md)).
3. **Import a model** and let it create its materials ([Models and materials](models-and-materials.md)).
4. **Give things colliders** so the level is solid ([Physics](physics.md)).
5. **Add a character and a controller**, and confirm you can walk around in Play
   ([AI agents](ai-agents.md), [Third-person example](../../examples/scripts/README.md)).
6. **Rig the animation** — clips, a blend space, a state machine ([Animation](animation.md)).
7. **Add the game's own rules** as scripts ([Scripting guide](../scripting/README.md)).
8. **Build a HUD** ([UI](ui.md)).
9. **Light it and grade it** ([Rendering](rendering.md)).
10. **Publish** ([Publishing](publishing.md)).

Steps 5 and 6 are the ones worth doing carefully — the shipped
[third-person character guide](../../examples/scripts/README.md) walks through a working setup with
measured numbers, and copying it is faster than deriving it.

## See also

[Core concepts](../concepts.md) · [Scripting guide](../scripting/README.md) · [Reference](../reference/node-types.md)
