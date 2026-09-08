# Terrain

Landscapes are heightfields with four paint layers and scattered foliage. Add one from
**Environment ▸ Landscape**, then switch to **Landscape mode** to shape it.

Landscape mode is only available in **3D scenes**.

## The node versus the brushes

Two different places, and the split matters:

- The **Landscape node inspector** (Scene mode) holds the terrain's **structure**: size,
  resolution, chunk quads, and heightmap import/export. Positioning uses the normal gizmo.
- **Landscape mode** holds the **brushes**. Nothing structural.

A new landscape defaults to `size 200`, `resolution 129`, `chunkQuads 32`.

## The brush card

A floating card in the viewport, with a landscape picker when the scene has more than one.

Shared sliders for all three modes:

| Slider | Range |
|---|---|
| **Radius** | 1 – 100 |
| **Strength** | 0.5 – 50 |
| **Falloff** | 0 – 1 |

### Sculpt

Tools: **Raise**, **Lower**, **Smooth**, **Flatten**.

> Flatten approaches its target asymptotically, and saving quantizes heights — so "flat" terrain
> still has micro-slopes. This is not a defect, but it is why a character with friction behaves
> differently in different directions on ground that looks level. See
> [Physics](physics.md#character-setup).

### Paint

Choose the active layer (**0–3**) and paint. Each layer holds a **terrain material**.

Four layers is the limit, because the blend weights are four channels of one splat texture.

### Foliage

Scatter the foliage defined by the painted materials, or switch to **Erase** mode to remove it.

- **Generate Foliage (whole terrain)** fills everything at once, and confirms first when doing so
  would discard instances you placed by hand.
- A status line reports instances placed, layers involved, and how close you are to the
  **200,000-instance ceiling**.

## Terrain materials

A terrain material (`.tmat`) is a paint layer. Open one to get:

- **Base surface** — the full material editor, on any of Basic, Blinn-Phong or PBR.
- **Terrain blend settings** — tiling, automatic placement by height and slope, height-based
  blending between layers.
- **Foliage rules** — what this surface scatters.

### Foliage rules

Each rule names a model or a billboard texture and a **density in instances per m²**, with an
estimate of how many instances that means over the terrain. Rules also carry LOD levels and can bake
an **impostor** — a billboard stand-in used past the distance where real geometry stops being worth
it.

There are also **exclusion** rules, so a material can say "not here" as well as "grass here".

Defaults: `2.0` per m² for billboards, `0.05` for meshes. Meshes are three orders of magnitude
sparser for the obvious reason.

> Foliage automatically refreshes when the model or material it uses is saved. Layers are keyed by a
> stable rule id, so renaming a rule does not orphan what it already placed.

## Foliage colliders

Foliage instances can carry pooled colliders, created **near the camera** rather than for every
instance — 200,000 colliders would be neither useful nor affordable. Configure this per rule.

## Level of detail

Terrain LOD is in [Renderer settings](../reference/render-settings.md#foliage-and-terrain-lod),
not here: two distances and two detail steps (½ and ¼). Foliage has its own cull distance, cell size and density falloff.

> The foliage cull distance and cell size interact with performance in a way worth knowing: foliage
> cost spikes while the **camera moves**, because that is when cells are admitted and the cull
> boundary is crossed. A steady frame rate standing still and spikes while walking is this, not a
> leak.

## Heightmaps

Import a heightmap with an amplitude, or export the current heights, from the node inspector. This
is the way to bring terrain in from an external tool.

## Physics

A landscape registers its heightfield **directly with the physics world, with no owning node**. Two
consequences:

- There is nothing to set up — terrain is solid as soon as it exists.
- A raycast hit with `hit.node === null` **is** a terrain hit, which is the cheapest terrain test
  there is. See [Raycasting](../scripting/motion-and-physics.md#raycasting).

## Runtime

Terrain can be queried and edited at runtime — `heightAt`, `raycast`, `sculpt`, `paint`, foliage
scattering. See [Terrain and tilemaps (scripting)](../scripting/terrain-tilemap.md).

## See also

[Models and materials](models-and-materials.md) · [Rendering](rendering.md) · [Terrain and tilemaps (scripting)](../scripting/terrain-tilemap.md)
