# Terrain

Landscapes are heightfields with a layered surface and scattered foliage. Add one from
**Environment ▸ Landscape**, then switch to **Landscape mode** to shape it.

Landscape mode is only available in **3D scenes**.

## The node versus the brushes

Two different places, and the split matters:

- **Landscape** — the node's section in the inspector (Scene mode). It holds the terrain's
  **structure**: size, resolution, chunk quads, paint resolution, and heightmap import/export.
  **Rebuild terrain** applies them, resampling the sculpted shape, the painted layers and the
  scattered foliage onto the new grid, so nothing authored is lost. Positioning uses the normal
  gizmo.
- **Landscape mode** holds the **brushes** — sculpt, paint and foliage. Nothing structural.

A new landscape defaults to `size 200`, `resolution 129`, `chunkQuads 32`.

## The layout

Landscape mode brings up two panels plus a slim toolbar:

- **Landscape Tools** — the mode, the tool, the brush, and whatever that tool needs.
- **Landscape Layers** — the landscape material and its slots: which one the brush paints, and how
  the viewport shows them.
- A **toolbar** floating over the viewport with the mode, the tools and the two settings that
  change mid-stroke: size and strength.

### Brush

The settings every tool strokes with, kept across tools; only the strength is remembered per tool.
Size and strength are on the toolbar too, so they can change without leaving the viewport.

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

### Shortcuts

The keys of Landscape mode, also listed in the **Shortcuts** section of Landscape Tools. They work
whenever no text field has the focus. The mode and tool keys wait while a mouse button is held,
because the editor camera flies on WASD and Q / E with the left button down.

| Key | Action |
|---|---|
| **Q / W / E** | Sculpt / Paint / Foliage |
| **1 … 0** | Pick a tool within the mode |
| **`[` / `]`** | Brush size; Ctrl+wheel does the same |
| **Shift + `[` / `]`** | Strength |
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

A landscape is painted with **one landscape material**, and only with it: Landscape mode never lists
the project's Materials, because what the surfaces are is authored in the landscape material. The
**Landscape Layers** panel shows it, top to bottom:

- **Landscape material** — the one this landscape paints with. Pick it from the library (or drop one
  on the picker), or **+ New landscape material**, which creates one, assigns it and opens it in the
  editor. ✎ opens it again.
- **Slots** — that material's slots, topmost first, down to the **Ground**, which covers the whole
  terrain and cannot be erased. *Auto* slots blend in by their rule — rock on the slopes, snow up
  high — with no painting. *Paint* slots (**Paint only** in the material) show nowhere until brushed
  on: roads, paths, riverbeds. Click one to paint it; it also has **Fill**, **Clear** and **Invert**.
  The viewport toolbar repeats the choice while in Paint mode.
- **View** — **Shaded** is the landscape as it renders, **Paint slot** a heat map of the active paint
  slot's weight, and **All** tints the ground by which surface is winning, which is the quickest way
  to see what a rule is actually doing.

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

## Foliage

Scatter the foliage rules of the landscape material, or switch to **Erase**.

- **Generate foliage everywhere** fills the whole landscape at once, and confirms first when doing
  so would discard instances placed by hand.
- A status line reports instances placed, layers involved, and how close you are to the
  **200,000-instance ceiling**.
- A surface with **Allow landscape foliage** off rejects the whole-landscape foliage — no grass on the
  rock slot. Its own foliage list still grows there.

## Landscape materials

A landscape material (`.tmat`) is everything a landscape is painted with. Open one to get:

- **Ground** — the surface covering the whole landscape, under everything the slots draw over it: a
  Material asset picked from the library, or **+ New material** made right there (from an older
  asset, it starts as a copy of the built-in surface). Tiling, with what one repeat measures in
  metres, whether the whole-landscape foliage may grow on it, and its own foliage lists.
- **Slots** — extra surfaces blended over the ground wherever their rule says so — rock on steep
  ground, snow above a height — each a Material (picked, or **+ New material**) with its own tiling
  and **blend rule**. Each draws over the slots before it, and the ground fills whatever they leave.
  **+ Slot** adds one that blends by rule; **+ Paint slot** adds one that is **Paint only**, brushed
  on in Landscape mode (its rule can still limit it, under *Limit by slope / elevation*). The preview
  does not show paint-only slots.
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

A landscape material grows foliage from three lists of rules: **Foliage — whole landscape**, anywhere
on the landscape where the surface allows it; **Foliage on Ground**, only where the ground itself
shows, not on the slots drawn over it; and each slot's **Foliage on this slot**, only where that slot
is the dominant surface — grass on a grass slot, pines on a forest slot. Each list has an exclusion
list beside it.

**Exclude foliage** — the list beside each foliage list, naming foliage to keep off rather than to
grow, whichever list it comes from: **Exclude foliage — whole landscape** keeps it off wherever this
material shows, **Keep off Ground** wherever the ground shows, and **Keep off this slot** wherever that
slot shows — a road keeping the grass and the trees off.

Each rule names a model or a billboard texture and a **density** — typed per 10 × 10 m block so a
sparse prop reads as a whole number, stored per m² — with an estimate of how many instances that
means over a 200 × 200 terrain. Rules also carry LOD levels and can bake an **impostor** — a billboard
stand-in used past the distance where real geometry stops being worth it.

**Bake impostor** makes one of two kinds, chosen by the rule's **Impostor** setting:

| Kind | What it is | Use for |
|---|---|---|
| **Octahedral** (default) | 8 × 8 views of the model over the upper hemisphere, with their normals, drawn on one camera-facing quad that blends the three nearest views. Lit by the scene like the mesh. | Trees and anything seen from several sides or from above. Holds up much closer than a card, so the mesh levels can hand over sooner. |
| **Flat card** | One front view on two crossed quads, lit into the texture. | Small plants, where one view is plenty and memory matters. |

The octahedral bake is made from the rule's **last** LOD level — the one it takes over from — so the
hand-over does not pop. **Impostor size** is the card's side for a card, the whole atlas's for an
octahedral bake (1024 = 128 px views; 2048 for a tree seen large).

Defaults: `2.0` per m² for billboards, `0.05` for meshes. Meshes are three orders of magnitude
sparser for the obvious reason.

A mesh rule's **See-through to camera** lets a camera rig in Dither collision mode see through its
instances — trees and tall props standing between the camera and the player are dithered away where
they block the view, instead of the camera pulling in. See the camera rig's **Collision** in the
[Node inspector](node-inspector.md).

A mesh rule's **Orientation** decides how each instance stands:

| Orientation | Use for |
|---|---|
| **Up** (default) | Upright whatever the slope: trees and grass. |
| **Ground normal** | Tilted to the slope under it: rocks bedded into a hillside. |
| **Free** | A random orientation per instance, the same every time: scattered stones. |

Changing it re-orients what is already placed without moving anything. Billboards always stand up.
A foliage collider still stands upright, so a tilted rock is best given a sphere collider.

> Foliage automatically refreshes when the model or material it uses is saved. Layers are keyed by a
> stable rule id, so renaming a rule does not orphan what it already placed.

## Foliage colliders

Foliage instances can carry pooled colliders, created **near the camera** rather than for every
instance — 200,000 colliders would be neither useful nor affordable. Configure this per rule.

A mesh rule's **Collision** picks the shape: cylinder, box or sphere, or none to walk straight
through. A newly picked shape starts fitted to the trunk; **Fit trunk** and **Fit bounds** refit it,
and **Edit collider…** opens the collider editor. Only instances within 40 m of the camera get a
body, and the nearest win once 256 are live. Turn on **Foliage colliders** in the viewport's eye menu
to see them on the landscape. Keep collision off anything grass-like.

### Collider editor

One prop with its collider drawn over it — drag to orbit, wheel to zoom — beside every dimension of
the shape. Nothing changes on the rule until **Apply**; **Reset** goes back to the collider the editor
opened with, and **Remove collider** leaves the prop with none.

- **Fit to trunk** — the radius of the bottom of the plant, spanning its lower part: what a character
  should bump into.
- **Fit to bounds** — around the whole plant, canopy included.
- **Centre height** — where the shape's centre sits above the instance's base. *Auto* is half the
  height (a sphere: its radius), so the shape stands on the ground.
- **Preview scale** — instances are scattered between the rule's min and max scale, and the collider
  scales with each one; this previews it at any scale in that range.

Dimensions are in prototype units, and a box's width and depth are full sizes.

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

**Import heightmap** — the dialog an import opens: **8- and 16-bit PNG** or **RAW / R16**, with the
heights a black and a white pixel map onto (terrain-local metres), plus rotate and flip, previewed
live on the landscape and applied as one undo step. **Cancel** puts the ground back exactly; the
painting and the foliage stay either way. A 16-bit file Cleo exported opens with its range already
filled in.

Export writes 16-bit PNG or RAW R16 and records the range in the file name, so a round trip through
an external tool keeps absolute heights. An 8-bit PNG export is normalised to the terrain's own range
and records none.

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
