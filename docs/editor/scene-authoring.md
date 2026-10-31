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

### Gameplay

The nodes a game's logic hangs on: empty holders and trigger volumes, and the pawn, driver and
navigation mesh that AI and player characters are built from.

| Entry | What you get |
|---|---|
| **Empty** | A bare node: a transform, children, somewhere to hang a script. |
| **Trigger** | An empty node with a 1 m sphere trigger volume. |
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

**Directional**, **Point**, **Spotlight**, and **Sky Light**, which lights the scene with the sky
itself (not placeable — it is scene-wide).

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

The world around the level: the sky, its light and clouds, the terrain, the wind, water, and the
volumes that tune how the scene is lit and culled.

| Entry | Notes |
|---|---|
| **Skybox** | Not placeable. **Removes any Sky Atmosphere.** |
| **Sky Atmosphere** | Not placeable. **Removes any Skybox.** |
| **Light Probe** | Default `10 × 10 × 10` influence volume. |
| **Exposure Volume** | A `10 × 10 × 10` box with its own exposure while the camera is inside. Overrides nothing until a field or preset is picked. |
| **Clouds (volumetric)** | Not placeable. |
| **Landscape** | Not placeable. `size 200`, `resolution 129`, `chunkQuads 32`. |
| **Wind** | Not placeable: one wind for the whole scene. Plants sway only where their material asks for it. |
| **Water Volume** | A `10 × 2 × 10` box of water: what is inside floats, and what moves through it ripples the surface. |
| **Occluder** | A `4 × 3 × 4` occlusion-culling volume, placed inside a building's walls or a cliff's bulk. |

Skybox and Sky Atmosphere are mutually exclusive: they are two answers to the same question.

### Effects

Things that are drawn on top of the world rather than being part of it: projected decals, particle
effects, and the force fields that push particles around.

| Entry | Notes |
|---|---|
| **Decal** | A `2 × 1 × 2` box that projects straight down, with a default PBR material. *(unreleased)* |
| **Particle System** | Starts with the default effect (soft rising puffs) so it is visibly doing something; **Create asset** on its slot turns that into a reusable `.vfx`. *(unreleased)* |
| **Force Field** | A spherical vortex that pushes the particles of emitters with the Force Fields module. *(unreleased)* |
| **Cloth** | A banner, 0.9 × 1.2 m, held along its top edge. Under a character, set **Ride On** to make it a cape. *(unreleased)* |

> **A freshly added primitive does not take a decal's colour.** Every primitive and complex geometry
> starts with the Blinn-Phong default material, which is shaded forward. A decal's colour, normal
> and roughness only reach deferred-shaded surfaces: PBR meshes, landscapes, foliage and deferred
> custom materials. Give the mesh a PBR material and the decal appears on it. The full list of
> limits is in
> [Node types](../reference/node-types.md#decalnode--decal-unreleased).

### UI — Layout

The roots and containers a UI is laid out with. **Canvas** (screen-space root, not placeable), **World UI** (world-space root, **placeable**, pivot
bottom-centre), **Column**, **Row**, **Spacer**.

### UI — Elements

The visible pieces of a UI: **Panel**, **Text**, **Image**, **Button**.

### UI — Widgets

Interactive controls with a value: **Progress**, **Slider**, **Toggle**, **Text Input**.

Any UI element dropped outside a UI root is automatically retargeted into the scene's first root,
creating one if there is none — so you cannot accidentally strand a button in world space.

## Selecting and moving

**Camera:** left-drag orbits, right-drag pans, wheel zooms. The pointer is only captured past a
small threshold, so a click still selects.

**Selection:** click to select, click empty space to deselect. Template instances select as one
object. Terrain and tilemaps use analytic pickers — a tilemap only registers a hit where a tile is
actually painted.

Selection is disabled in the modes where it would not mean anything: landscape, tilemap, UI,
renderer, input, material, terrain material, animation and blend space.

**Gizmos:** the floating top-right chrome has **Move / Rotate / Scale**, the debug overlay eye menu,
and a **2D/3D view switch**. Selecting one of a node's collision shapes turns Move and Rotate onto that
shape and adds its size handles — see [Editing shapes in the viewport](physics.md#editing-shapes-in-the-viewport).

### Volume handles

A selected light probe (with a bounded box) or exposure volume shows its box as a wireframe, with the
same square handles as a collision shape on all six faces. Dragging one moves that face alone: the
opposite face stays put and the node moves by half the change. Hold **Alt** to grow both sides about
the centre, and **Ctrl** to snap the size to the translate step. **Escape** during a drag puts the box
back. The node's own Move, Rotate and Scale gizmo stays up alongside, and each drag is one undo step.

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

> The **structure** of a placed instance is read-only in the scene: its children, meshes, materials,
> colliders and attached scripts all come from the template, so open the template to change them.
> This is what keeps every instance consistent when the template changes.

**Overrides — what each instance keeps of its own.** Besides its transform, an instance may differ
from its template in:
- the **name of its root** (rename it in the tree or the inspector; the children keep the template's names);
- the **value of any script field**, on its root or on any node inside it (edit it in the Scripts section).

These are recorded on the instance as **overrides** and replayed whenever the instance is rebuilt from
its template, so editing the template never wipes them. An overridden value shows a **revert** marker
that puts the template's value back; **Revert all** in the template-instance banner drops them all. A
field you have not overridden follows the template: change its default in the template and every
instance that kept the default changes too.

Placed instances are rebuilt when the template changes, with fresh node ids and internal references
remapped so each copy points at its own parts. This is why anything that references a node inside a
template — a controller's possession, a camera rig's follow target — should live **inside** the
template too. A reference from outside keeps pointing at the id the original had.

### Template variants

A **variant** is a template based on another template. It inherits the base's whole tree and records
only what it changes, so when the base is edited every variant follows — except where the variant
changed that value itself. Typical use: one **Weapon** base, and a variant per weapon; one **Enemy**
base, and a variant per enemy type.

**Creating one:** right-click a template in Assets ▸ **Create Variant**. It opens in its own tab.

**What a variant can change** — anything, on any node:
- a value (a field, a script field, a transform, a material, a light) on an inherited node;
- the **script** attached to a node — typically a script that `extends` the base's script;
- **added** nodes (a sword's blade, its moves) and **removed** ones (a boss without a health bar).

In a variant's tab a banner names its base, and an overridden **script field** shows a **revert** marker
that takes the base's value back. Saving records the differences against the base as it was when the
tab opened, so an edit made to the base meanwhile is not mistaken for the variant's own.

Nodes are matched to the base **by name path**: renaming an inherited child, or reordering children,
reads as removing it and adding a new one (it stops following the base). A variant can be the base of
another variant. Placed copies of a variant work like any template's, overrides included.

**Deleting a base** keeps its variants: each becomes a standalone template with the content it had.

**Going back to the base.** In a variant's tab, **Revert node** drops everything the variant changed on
the selected node — any value, its collider, its script — and **Revert all** does it for every node (the
variant keeps its name; added and removed nodes stay). Both save first.

**Based on** in the same banner moves the variant onto another template: what it looks like now is kept,
and from then on it follows the new base. A template based on the variant itself cannot be chosen.

**From a placed copy.** A copy whose overrides you want to keep as an asset: select it, and press **Make
variant** in the template-instance banner. Its overrides become the new variant's own changes, and the
copy is relinked to it.

## Undo and redo

**Ctrl+Z** / **Ctrl+Shift+Z**. There is **one history per tab**: undoing in a material tab cannot
reach into the scene graph.

Structural changes (add, remove, re-parent, spawn, despawn) get an exact inverse. Everything else is
recorded as a snapshot diffed across an *interaction*, which closes after a short idle — so dragging
a slider is one undo step rather than sixty.

The undo button's tooltip names the change kind: Transform, Rename, Visibility, Variable, Physics,
Script, Material, Texture, Light, Camera, Environment, Component.

Rigid bodies and triggers are not part of a node's snapshot, so the Physics panel and the viewport's
collision handles record their own steps: one per edit, per drag of a field, or per handle drag, named
for what it did ("Resize body shape", "Add trigger shape").

A tilemap stroke is pushed as one entry, so **Ctrl+Z undoes a whole stroke**.

## Debug overlays

The eye menu in the viewport toggles helpers, each with **two independent switches: Editor and
Runtime**. That separation is the point — you can leave collision wireframes on while authoring and
off in Play, or turn navmesh display on *during* Play to see what an agent is walking on.

- **Overlay** — the helper the row switches.
- **Editor** — whether it draws while you author, and while you Simulate (Simulate is watched through
  the editor's eyes).
- **Runtime** — whether it draws in Play. Greyed out for the rows that mean nothing in a running game.

| Category | Default (editor) |
|---|---|
| Collision wireframes | on |
| Trigger volumes | on |
| Light icons | on |
| Camera frustums | on |
| Light probes | on |
| Exposure volumes | on |
| Decal icons | on |
| Sound emitters | on |
| Bounding boxes | off |
| Skeletons | off |
| Animation blend | off |
| Navigation mesh | off |
| Foliage colliders | on |
| Effect icons | on |
| Preview particles | on — whether particle effects simulate while you author; editor only, since a running game always simulates them |
| Game UI | off — always shown in UI mode and in Play |
| Reference grid | on |

**Animation blend** shows, in a corner of the viewport, every link from an animated model's
parameters to its pose, sampled live, with how much each value moved over the last second (a settled
value reads 0, a buzzing one its amplitude) and the last few state changes — so a state machine
ping-ponging between two states names the pair. Turn its **Runtime** switch on to read it in Play: a
blend driven by measured motion reads 0 in the editor, which has no physics.

Every helper is an editor-only node: never serialized, never lit, and structurally absent from a
published build.

## Scene settings

Selecting the scene root shows the settings of the scene asset itself rather than of a node, in two
sections.

### Scene

The scene asset: its name, what kind of scene it is, and whether a published game starts in it.

| Setting | Meaning |
|---|---|
| **Name** | The scene's name in the project. |
| **ID**, **Saved** | Read-only: the scene's id, and when it was last saved. |
| **Type** | **2D** or **3D**. Decides Landscape versus Tilemap mode, and what a build keeps. |
| **Set as main scene** | The scene a published game starts in. |

> Switching a scene's 2D/3D type warns first when it would strand authoring work — a landscape in a
> scene about to become 2D, or a tilemap in one about to become 3D. A published build **discards**
> the data for the dimension it is not using, so the warning is about real loss, not tidiness.

### Environment (scene settings)

The scene's background and its baseline lighting: what it is cleared to, its flat ambient fill and
its reflections.

| Setting | Meaning |
|---|---|
| **Clear color** | Background where nothing is drawn. |
| **Ambient** and **Ambient (lx)** | Scene-wide ambient fill: its colour, and its strength in lux. It lights every shadow evenly and does not darken with the sky; a [Sky Light](node-inspector.md#sky-light) scales it. A scene with a sky light or a light probe wants it near zero; one with neither needs it, or unlit surfaces go black. |
| **Reflections** | The environment map PBR and Blinn-Phong materials reflect. **Use skybox** takes it from the scene's Skybox node, **Clear** removes it. It is saved inside the scene, so a scene with one is much bigger. |

## See also

[Node inspector](node-inspector.md) · [Modes](modes.md) · [Physics](physics.md) · [Node types](../reference/node-types.md)
