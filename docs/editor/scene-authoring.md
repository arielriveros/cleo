# Scene authoring

Building the scene tree: adding nodes, arranging them, selecting and moving them, making prefabs,
and seeing what is normally invisible.

## The hierarchy

A virtualized tree with per-type icons. You can:

- **rename** inline (names are validated),
- **toggle visibility** with the eye,
- **drag to re-parent**,
- **drop new nodes, models, templates and scripts** onto a node to add them under it,
- **drag a node out onto the Assets panel** to save it as a template.

Selecting the tree's **root** shows [Scene settings](#scene-settings) instead of a node inspector.

## The Add catalog

Two palettes: **Scene Elements** and **UI Elements** (the latter appears in UI mode). Both are icon
grids with a category selector, and your category choice is remembered.

Every entry can be **clicked** — which parents it under the current selection — or **dragged** into
the tree or the viewport. A dragged entry lands at the point under the cursor unless it is marked
not placeable.

### Common

| Entry | What you get |
|---|---|
| **Empty** | A bare node: a transform, children, somewhere to hang a script. |
| **Trigger** | An empty node with a 1 m sphere trigger volume. |

### Gameplay

| Entry | What you get |
|---|---|
| **Character** | A pawn. *(unreleased)* |
| **Controller** | A driver that possesses a character. *(unreleased)* |
| **Nav Mesh** | A navmesh node with a default `20 × 10 × 20` bake box. *(unreleased)* |

> The Nav Mesh box defaults to a real size rather than the class default of "whole scene", so a node
> you just added shows its volume and cyan preview immediately. Scenes saved before volumes existed
> stay unbounded.

### Cameras

**Perspective**, **Orthographic**, **Camera Rig** (which ships with a perspective camera child
already attached).

### Lights

**Directional**, **Point**, **Spotlight**.

### Audio

**Spatial Sound**, **Ambient Sound** *(not placeable — it has no position)*.

### Sprites

**Static sprite**, **Animated sprite**, **Tilemap** (orthogonal, 1×1 cells, one "Ground" layer).

### Primitive Geometries

Cube, Sphere, Capsule, Cylinder, Cone, Torus, Pyramid, Quad, **Plane** (2×2 with 16×16
subdivisions, so it can be displaced), Circle, Triangle.

### Complex Geometries

Ramp, Corner Ramp, Stairs, Spiral Stairs, Arch, Tube, Hollow Box — unit-size blockout shells for
level layout.

### Environment

| Entry | Notes |
|---|---|
| **Skybox** | Not placeable. **Removes any Sky Atmosphere.** |
| **Sky Atmosphere** | Not placeable. **Removes any Skybox.** |
| **Light Probe** | Default `10 × 10 × 10` influence volume. |
| **Sky Light** | Not placeable. |
| **Clouds (volumetric)** | Not placeable. |
| **Landscape** | Not placeable. `size 200`, `resolution 129`, `chunkQuads 32`. |

Skybox and Sky Atmosphere are mutually exclusive: they are two answers to the same question.

### UI — Layout

**Canvas** (screen-space root, not placeable), **World UI** (world-space root, **placeable**, pivot
bottom-centre), **Column**, **Row**, **Spacer**.

### UI — Elements

**Panel**, **Text**, **Image**, **Button**.

### UI — Widgets

**Progress**, **Slider**, **Toggle**, **Text Input**.

Any UI element dropped outside a UI root is automatically retargeted into the scene's first root,
creating one if there is none — so you cannot accidentally strand a button in world space.

## Selecting and moving

**Camera:** left-drag orbits, right-drag pans, wheel zooms. The pointer is only captured past a
small threshold, so a click still selects.

**Selection:** click to select, click empty space to deselect. Template instances select as one
object. Terrain and tilemaps use analytic pickers — a tilemap only registers a hit where a tile is
actually painted.

Selection is disabled in the modes where it would not mean anything: landscape, tilemap, UI,
renderer, input, material, terrain material, animation and animation field.

**Gizmos:** the floating top-right chrome has **Move / Rotate / Scale**, the debug overlay eye menu,
and a **2D/3D view switch**.

> The 2D/3D switch in the viewport is **view-only**. The scene's authored dimension is a different
> setting, in Scene settings, and it is the one that decides whether you get Landscape or Tilemap
> mode and what a build keeps.

**Dropping into the viewport:** a dropped template, model or node is placed at the first thing it
hits — terrain, then the tilemap plane, then geometry, then the ground plane, and failing all of
that, ten units in front of the camera.

## Templates

A template is a saved node subtree — a prefab.

**Creating one:** drag a node from the hierarchy onto the Assets panel and confirm.

**Placing one:** drag it from Assets into the viewport or the tree.

**Editing one:** open the template asset, which opens [Template mode](modes.md) — a throwaway scene
rooted at the template's root.

> Anything inside a placed instance is **read-only in the scene**, except its transform. To change a
> field on something inside a template, open the template. This is what keeps every instance
> consistent when the template changes.

Placed instances are rebuilt when the template changes, with fresh node ids and internal references
remapped so each copy points at its own parts. This is why anything that references a node inside a
template — a controller's possession, a camera rig's follow target — should live **inside** the
template too. A reference from outside keeps pointing at the id the original had.

## Undo and redo

**Ctrl+Z** / **Ctrl+Shift+Z**. There is **one history per tab**: undoing in a material tab cannot
reach into the scene graph.

Structural changes (add, remove, re-parent, spawn, despawn) get an exact inverse. Everything else is
recorded as a snapshot diffed across an *interaction*, which closes after a short idle — so dragging
a slider is one undo step rather than sixty.

The undo button's tooltip names the change kind: Transform, Rename, Visibility, Variable, Physics,
Script, Material, Texture, Light, Camera, Environment, Component.

A tilemap stroke is pushed as one entry, so **Ctrl+Z undoes a whole stroke**.

## Debug overlays

The eye menu in the viewport toggles helpers, each with **two independent switches: Editor and
Runtime**. That separation is the point — you can leave collision wireframes on while authoring and
off in Play, or turn navmesh display on *during* Play to see what an agent is walking on.

| Category | Default (editor) |
|---|---|
| Collision wireframes | on |
| Trigger volumes | on |
| Light icons | on |
| Camera frustums | on |
| Light probes | on |
| Sound emitters | on |
| Reference grid | on |
| Bounding boxes | off |
| Skeletons | off |
| Animation blend | off |
| Navigation mesh | off |

Every helper is an editor-only node: never serialized, never lit, and structurally absent from a
published build.

## Scene settings

Selecting the scene root shows:

| Setting | Meaning |
|---|---|
| **Name**, **ID**, **Last saved** | |
| **Scene type: 2D / 3D** | Decides Landscape versus Tilemap mode, and what a build keeps. |
| **Set as main scene** | The scene a published game starts in. |
| **Clear color** | Background where nothing is drawn. |
| **Ambient color** and **ambient lux** | Scene-wide ambient light. |
| **Reflections** | *Use skybox* or *Clear*. |

> Switching a scene's 2D/3D type warns first when it would strand authoring work — a landscape in a
> scene about to become 2D, or a tilemap in one about to become 3D. A published build **discards**
> the data for the dimension it is not using, so the warning is about real loss, not tidiness.

## See also

[Node inspector](node-inspector.md) · [Modes](modes.md) · [Physics](physics.md) · [Node types](../reference/node-types.md)
