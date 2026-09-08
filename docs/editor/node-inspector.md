# Node inspector

The **Properties** panel. What it shows depends on the selected node's type.

Every selection is composed the same way:

1. **Node info** — name, node type, Delete.
2. **Transform** — position, rotation (degrees), scale. Hidden for screen-space UI, which has no
   meaningful transform.
3. **Model slot**, when the node has geometry.
4. **A type-specific editor.**

Selecting the scene **root** shows [Scene settings](scene-authoring.md#scene-settings) instead.

> Everything except Transform is **disabled** on a node inside a placed template instance. Open the
> template to change it. A notice in the panel says so and offers to unlink.
>
> The node **type** can only be changed on a template root.

## Common sections

| Section | Appears on | What it does |
|---|---|---|
| **Model** | Nodes with geometry | Which model asset it came from, and a jump into the model editor. |
| **Material** | Model nodes | Linked material thumbnail, edit / unlink / create. **One slot per submesh** on a merged import. |
| **Animation** | Nodes that are, or contain, a skinned model | Clips, linked `.anim` assets, animation fields, and the button into the Animation Editor. |
| **Scripts** | Any node | The script slot, plus that script's per-node variables. |
| **Physics** | Any node | See [Physics](physics.md). |

> The Model and Animation sections appear only on the node that actually has the mesh, or on the
> root of a placed model instance. They no longer appear on cameras, spatial sounds or any ancestor
> above a mesh — those were showing because a debug helper counted as a child.

## By node type

### Cameras

**Camera** — projection (perspective / orthographic), FOV or orthographic size, near and far clip
planes, and a **post-processing chain** listing the built-in effects in order.

**Camera Rig** — follow target and offset, follow space and damping, aim mode (orbit / look-at /
none), yaw and pitch sensitivity and limits, **arm length**, **socket offset**, FOV blending,
**collision** (radius, minimum ratio, pull and return times, ignore list), and shake.

> Put a shoulder offset on **Socket Offset**, not on the camera child — the rig rewrites the child's
> whole local position every frame.

### Lights and environment

**Light** — photometric intensity (lux for directional, lumens for point and spot), colour,
per-kind parameters, shadow casting.

**Light Probe** — influence volume, blend distance, intensity, capture mode and bake controls.

**Skybox** — six cube faces.

**Sky Atmosphere** — sun, atmosphere, quality, fog and god-ray parameters. See
[Node types](../reference/node-types.md#skyatmospherenode--skyatmosphere).

**Sky Light** — intensity, tint, cloud response, and an L0 read-out that separates "the projection
has not landed yet" from "the sky really is that dim".

**Volumetric Clouds** — shape, lighting, animation, quality and render parameters.

### Gameplay

**Character** — the pawn's movement capabilities: walk and run speeds, jump, turn speed and
threshold, direction smoothing, acceleration, air control, coyote time, jump buffering, facing mode.

**Controller** — the agent hub. See [AI agents](ai-agents.md).

**Nav Mesh** — bake bounds, bake settings and the Bake button. See
[AI agents](ai-agents.md#navigation-meshes).

### 2D

**Sprite** — tileset plus one tile, chosen from a tile grid.

**Animated Sprite** — an ordered tile list (drag a rectangle over the atlas), or the tile's own
animation metadata; fps and loop.

**Sprite appearance** — tint, opacity, blending. **Tileset slot** — which tileset a sprite uses.

**Tilemap** — grid kind, cell width and height, sprite sort layer, collider depth.

### Terrain

**Landscape** — the terrain's **structure**: size, resolution, chunk quads, and heightmap
import/export. The brushes are in [Landscape mode](terrain.md), not here.

### Audio

**Sound** — emitter behaviour: spatial or ambient, volume multiplier, attenuation. The sample's own
settings (loudness, loop points, fades, bus, effects) live in the [sample editor](audio.md).

### UI

One editor for every UI type, in three parts: the element's own payload, **Anchor & Rect**
(anchor min/max, offset min/max, pivot), and **Appearance**. See [UI](ui.md).

## Materials

The material editor is reached from a model node's material slot, or by opening a `.mat` asset.
Shader modes: **Basic**, **Blinn-Phong**, **PBR**, **Cel (toon)**, **Custom (shader)**.

Sections, depending on the shader: Colours (diffuse, specular, ambient, emission, shininess,
opacity), Textures, Cutout, Toon, Properties, **Height** (displacement, world-unit versus UV depth,
tessellation, clip-at-UV-border), and Options (side, transparency, shadow casting, wireframe).

Full detail: [Models and materials](models-and-materials.md#the-material-editor).

## Node references

Several fields name another node — a camera rig's follow target, a controller's possession, a
camera's focus target. These use a node picker rather than a text field, and they are remapped when
a template is instantiated so a copy points at its own parts.

## See also

[Scene authoring](scene-authoring.md) · [Physics](physics.md) · [Node types](../reference/node-types.md)
