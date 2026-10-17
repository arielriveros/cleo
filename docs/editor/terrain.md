# Terrain

Landscapes are heightfields with a layered surface and scattered foliage. Add one from
**Environment ▸ Landscape**, then switch to **Landscape mode** to shape it.

Landscape mode is only available in **3D scenes**.

## The node versus the brushes

Two different places, and the split matters:

- The **Landscape node inspector** (Scene mode) holds the terrain's **structure**: size,
  resolution, chunk quads, paint resolution, and heightmap import/export. Positioning uses the
  normal gizmo.
- **Landscape mode** holds the **brushes**. Nothing structural.

A new landscape defaults to `size 200`, `resolution 129`, `chunkQuads 32`.

## The layout

Landscape mode brings up two panels plus a slim toolbar:

- **Landscape Tools** — the mode, the tool, the brush, and whatever that tool needs.
- **Landscape Layers** — the base material and the paint-layer stack.
- A **toolbar** floating over the viewport with the mode, the tools and the two settings that
  change mid-stroke: size and strength.

### Brush

| Setting | What it does |
|---|---|
| **Size** | Radius in metres, 0.5 – 250, on a logarithmic slider. `[` / `]`, or Ctrl+wheel. |
| **Strength** | Per tool, and remembered per tool. Metres per second for Raise/Lower, a 0–1 blend for the rest. Shift+`[` / `]`. |
| **Falloff** | 0 is a hard edge, 1 feathers all the way from the centre. |
| **Curve** | Soft, Smooth, Linear, Sphere, Tip. |
| **Shape** | Circle or square, with a rotation. |
| **Hold to apply** | Keep applying while the mouse is held still, rather than only while it moves. |

The cursor is a decal projected onto the ground: a gradient of the brush's own weight curve,
coloured per tool and as opaque as the strength.

### Modifiers and hotkeys

| Key | Action |
|---|---|
| **Q / W / E** | Sculpt / Paint / Foliage |
| **1 … 0** | Pick a tool within the mode |
| **Shift + drag** | Invert: Lower instead of Raise, erase instead of paint |
| **Ctrl + drag** | Smooth, whatever the tool |
| **Ctrl + click** | Flatten and Set Height: pick the height under the cursor |
| **Esc** | Cancel a ramp |

Every stroke is **one undo step**, and so is a fill, an invert or a heightmap import.

## Sculpt

| Tool | What it does |
|---|---|
| **Raise / Lower** | Build up or dig down, in metres per second. |
| **Smooth** | Average away bumps, region-local. |
| **Flatten** | Level to the height where the stroke started. Fill only / cut only / both. |
| **Set Height** | Move ground toward an exact height, typed or picked. |
| **Ramp** | Press at one end, release at the other. Brush size is the half-width; falloff softens the sides. |
| **Noise** | Fractal noise with a scale and a seed. |
| **Terrace** | Cut slopes into flat steps: step height and sharpness. |
| **Erode** | Thermal erosion — anything steeper than the talus angle slumps into scree. |
| **Hydro** | Rain erosion — droplets carve gullies and deposit in hollows. |
| **Stamp** | A grayscale image as the brush alpha, with rotation. White raises. |

> Flatten approaches its target asymptotically, and saving quantizes heights — so "flat" terrain
> still has micro-slopes. This is not a defect, but it is why a character with friction behaves
> differently in different directions on ground that looks level. See
> [Physics](physics.md#character-setup).

## Paint

A landscape is painted with **one landscape material**, chosen at the top of the **Landscape
Layers** panel — from the library, or **+ New landscape material**, which creates one, assigns it
and opens it in the editor. ✎ opens it again. Landscape mode never lists the project's Materials:
what the surfaces are is authored in the landscape material.

The panel lists that material's slots, topmost first:

- The **Ground** covers the whole terrain. Nothing can erase it.
- **Auto** slots blend in by their rule — rock on the slopes, snow up high — with no painting.
- **Paint** slots (Paint only in the material) show nowhere until brushed on: roads, paths,
  riverbeds. Click one to paint it; it also has **Fill**, **Clear** and **Invert**. The viewport
  toolbar repeats the choice while in Paint mode.

Paint, Erase and **Clear to ground** work toward a target opacity — paint a dirt road at 60% and it
stops there. Erasing a road reveals what is under it, automatic slots included. Painting is kept per
slot, so editing and saving the landscape material keeps it; removing a paint slot discards its
painting.

Fifteen paint slots, and sixteen surfaces on screen at once. Masks are their own resolution
(**Paint resolution** in the node inspector, 256–2048), independent of the height grid, because a
road needs finer texels than a hill does.

Landscapes saved with the older **paint layers** convert on open: each layer becomes paint slots
carrying its painted mask, and the material becomes embedded — **Save to library and edit** puts it
back in the library. A layer's foliage rules join the material's own.

**View → All** tints the ground by which surface is winning, which is the quickest way to see what
a rule is actually doing.

## Foliage

Scatter the foliage rules of the landscape material, or switch to **Erase**.

- **Generate foliage everywhere** fills the whole landscape at once, and confirms first when doing
  so would discard instances placed by hand.
- A status line reports instances placed, layers involved, and how close you are to the
  **200,000-instance ceiling**.
- A slot with **Allow foliage** off rejects candidates — no grass on the rock slot.

## Landscape materials

A landscape material (`.tmat`) is everything a landscape is painted with. Open one to get:

- **Ground** — the surface covering the whole landscape: a Material asset picked from the library,
  or **+ New material** made right there (from an older asset, it starts as a copy of the built-in
  surface). Tiling, with what one repeat measures in metres, and whether foliage may scatter.
- **Slots** — surfaces over the ground, each a Material (picked, or **+ New material**) with its own
  tiling and **blend rule**. **+ Slot** adds one that blends by rule; **+ Paint slot** adds one that is
  **Paint only**, brushed on in landscape mode (its rule can still limit it, under *Limit by slope /
  elevation*). The preview does not show paint-only slots.
- **Foliage rules** — what this material scatters.

### How a surface reads on the landscape

A landscape surface draws from its Material the same maps a mesh does: **base colour**, **normal**,
**roughness**, **metallic** and **occlusion** (a packed ARM/ORM texture works when it fills several of
those slots). The **height** map does not displace the ground (landscapes have no parallax); it only
shapes the transitions between surfaces (**Height blend**). Each Ground and slot also has:

- **Normal strength** — how strongly the normal map tilts the light (1 = as authored).
- **Break up tiling** — varies each tile so a texture's repeat stops showing from a distance. Costs a
  second texture fetch for that surface.

The **base colour multiplies the texture**: a white texture (snow) under a grey tint can never be
whiter than the tint, and the material editor warns when a texture sits under a non-white colour.
Every landscape surface is resampled to the renderer's **Surface Tex** size (1024 by default; 2048 for
close-up detail).

Editing a Material asset updates every ground and slot that uses it.

### Blend rules

A rule says **where** a surface appears. Every test multiplies, and a disabled test passes
everywhere:

| Test | Unit |
|---|---|
| **Elevation** | Metres **above the landscape's origin** — so moving a landscape does not move its snow line. Min, max and a falloff either side. |
| **Slope** | Degrees: 0 flat, 90 vertical. |
| **Noise** | Breaks the transition into an irregular edge: amount, feature size in metres, seed. |
| **Height blend** | 0–1. Lets the surface's height map decide the transition, so gravel and cobbles poke through first. |
| **Opacity** | Scales the whole rule. |

This is how one material becomes grass that turns to rock on the steep parts and snow above a
height, without painting any of it.

### Preview

The material preview switches between **Sphere**, **Plane** and — for a landscape material — a
**Hill**, from the control at the top right of the viewport.

- The sphere shows every angle a surface can face, which is why it is also the thumbnail.
- The plane shows how the material tiles on flat ground.
- The hill has real slopes and real elevation, so elevation and slope rules show as bands exactly
  where they will land on a landscape.

Because a preview is a few metres across and a rule is authored in landscape metres, the preview
remaps its height onto the span the rules actually use, and the legend under the switch says what
its height stands for.

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

The size the surface textures are resampled to — they share one texture array, so they share one
size — is **Landscape texture size** in renderer settings: 512, 1024 (the default) or 2048.

> The foliage cull distance and cell size interact with performance in a way worth knowing: foliage
> cost spikes while the **camera moves**, because that is when cells are admitted and the cull
> boundary is crossed. A steady frame rate standing still and spikes while walking is this, not a
> leak.

## Heightmaps

Import and export from the node inspector.

Import opens a dialog: **8- and 16-bit PNG** or **RAW / R16**, with the minimum and maximum height
the image maps onto, plus rotate and flip, previewed live and applied as one undo step. Export
writes 16-bit PNG or RAW R16 and records the range in the file name, so a round trip through an
external tool keeps absolute heights.

> A 16-bit import is worth insisting on for large landscapes: 8 bits over a 300 m range quantizes
> to about 1.2 m, which reads as terracing on any gentle slope.

## Physics

A landscape registers its heightfield **directly with the physics world, with no owning node**. Two
consequences:

- There is nothing to set up — terrain is solid as soon as it exists.
- A raycast hit with `hit.node === null` **is** a terrain hit, which is the cheapest terrain test
  there is. See [Raycasting](../scripting/motion-and-physics.md#raycasting).

## Runtime

Terrain can be queried and edited at runtime — `heightAt`, `raycast`, `sculpt`, `paintLayerMask`,
foliage scattering. See [Terrain and tilemaps (scripting)](../scripting/terrain-tilemap.md).

## See also

[Models and materials](models-and-materials.md) · [Rendering](rendering.md) · [Terrain and tilemaps (scripting)](../scripting/terrain-tilemap.md)
