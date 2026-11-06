# World Creator

Build a landscape from a stack of landform layers, erode it, texture it with a stack of rule-placed
surfaces, and export it in the formats every engine reads. Nothing is baked: every change re-evaluates
what it affects. The live preview runs on a real engine landscape in the viewport (257² or 513², see
[Preview quality](#preview-quality)) and on the **Map**; **Generate & export** (toolbar) runs the full
resolution. **Layers** is the left dock; **Parameters** (world settings, lakes and the selected layer,
pass or surface, with the world presets in its header) and **Export** are the right dock.

Heights are a fraction of the **Height scale** (0 the lowest ground, 1 a full-height peak; layers may
overshoot and erosion may cut below 0). Positions are map coordinates, 0 to 1 across the world, with
(0, 0) the -X/-Z corner, the same orientation the engine's heightmap import uses. North is -Z (the top
of the Map).

## World settings

The frame every layer and pass works in.

| Field | Meaning |
|---|---|
| **World size** | World units across the map. |
| **Height scale** | World units of a height of 1. |
| **Seed** | The world's seed. Every layer, erosion pass and surface noise derives its randomness from it; change it for a new variation of the same design. |
| **Sea level** | Normalised height of the sea. The sea fills in from the map's edges up to it; the water rules measure from it. |

## Lakes

The sea reaches every cell whose way off the map never rises above sea level. Basins it cannot reach
fill as lakes, each at its own level: the height its water would spill out at (priority flood, Barnes
et al. 2014).

| Field | Meaning |
|---|---|
| **Lakes** | Fill the basins the sea does not reach. |
| **Min depth** | A basin shallower than this at its deepest holds no lake, metres. |
| **Min area** | Smaller lakes are dropped, m². |
| **Fill** | 1 fills each basin to its spill point; less leaves it lower, between its floor and that point. |

Lake levels and the sea level travel in the manifest as plain numbers. The water itself is
[preview only](#water-preview).

## Layers

The left dock: the **Landforms**, the **Erosion** passes and the **Surfaces**. Click one to edit it in
Parameters; the toggle switches it off without removing it.

## Landforms

Applied top to bottom: each reads the height the ones above it made.

| Layer | What it does |
|---|---|
| **Noise** | Fractal gradient noise, blended in by its **Blend** mode. *fBm* rolls, *Ridged* makes sharp crests, *Billow* makes rounded hills. **Warp** folds the pattern. |
| **Mountain** | A peak with ridged flanks around a centre you drag on the map. |
| **Ridge** | Raised ground along a spline. |
| **Valley** | Lowered ground along a spline. |
| **River** | Carves a channel along a spline down to a bed that runs from **Bed at source** to **Bed at mouth**. Never raises the ground. |
| **Road** | Flattens a strip along a spline to an evenly graded road, with cut-and-fill shoulders. |
| **Plateau / cliff** | Lifts the ground inside a radius to a level; a small **Edge** makes a cliff. |
| **Terraces** | Steps the heights inside a band, like strata. |
| **Crater / lake** | A bowl with a raised rim. |
| **Coast / beach** | Sinks the land beyond a shoreline to a shelf under the sea, with a flattened beach just above sea level. |

**Strength** fades any layer from off (0) to full (1).

Splines and centres are edited on the **Map**: select the layer, drag its handles, double-click to add a
spline point, Alt+click to remove one.

## Erosion

Run after the landforms, in order.

| Pass | What it does |
|---|---|
| **Thermal** | Material slumps off any slope steeper than the **Talus angle**, softening cliffs into scree. Conserves material. What it piles up is the surfaces' **Talus**. |
| **Hydraulic (droplets)** | Many single raindrops roll downhill, eroding where they speed up and depositing where they slow: gullies and alluvial fans. What they lay down is **Deposits**, what they cut is **Wear**. |
| **Hydraulic (virtual pipes)** | A shallow-water simulation (Mei et al. 2007): rain flows between cells through virtual pipes and carries sediment. Runs on the GPU when available. Also produces the flow and wetness masks, and Deposits and Wear. |

Erosion works in grid cells, so the same settings erode a 2049 export more finely than the 257 preview;
check the full-resolution result before committing to a look.

## Surfaces

What the ground is made of, and where: Sand, Grass, Rock, Scree, Snow. An ordered stack, listed top
first with the base pinned at the bottom, the way the editor's landscape Layers panel lists slots. The
base covers the whole map; each surface above covers what its rules select, over whatever is below it.

The export says only **where** each surface is (splat and weight maps, normalised weights). The
material that represents it is chosen wherever the maps are used: in the editor, each surface maps onto
a slot of the landscape's material ([Import world](../editor/terrain.md#import-world)). The materials the
Creator shows are generated for the preview and never exported.

**+ Add** offers ready-made surfaces, and, under *Replace all with a biome*, whole stacks:

| Biome | Surfaces |
|---|---|
| **Temperate** | Grass, dirt, forest floor, seabed, beach sand, mud, riverbed, rock slopes, scree, snow. |
| **Alpine** | Alpine meadow, seabed, riverbed, scree, rock slopes, cliff, shaded snow, snow. |
| **Desert** | Hardpan, desert sand, gravel washes, scree, rock slopes, banded cliffs. |
| **Tropical coast** | Lush grass, forest floor, seabed, beach sand, wet sand, mud, rock slopes. |

A world preset (Parameters header) replaces the terrain but keeps the surfaces.

Each row's caption is the share of the map the surface covers in the preview.

### Surface

| Field | Meaning |
|---|---|
| **Name** | What the surface is called here and in the exported files and manifest. |

### Conditions

What a surface covers. Each condition reads one of the terrain's values and passes a band of it fully,
fading out over its **Fade in** and **Fade out**; the graph behind the band is how much of the map has
each value. The first condition starts the mask; each next one joins it by its mode: **and** (multiply),
**or** (max), **add**, **subtract**, **min**. **Not** inverts a condition. Every value is in world units
(metres, degrees, m²), so a rule reads the same on the preview as on a 4097² export.

| Input | Reads |
|---|---|
| **Height** | Ground height above the world origin, m. |
| **Height above water** | Ground height above the nearest sea or lake surface, m: beaches, banks, flood plains. Negative under water. |
| **Relative height** | 0 at the map's lowest point, 1 at its highest. |
| **Slope** | Steepness in degrees, 0 flat to 90 vertical. |
| **Aspect** | The compass direction a slope faces: **Facing** (0 north = -Z, 90 east = +X), **Spread** either side, **Fade** beyond. Flat ground reads as half. |
| **Curvature** | Convex (crests, positive) to concave (gullies, negative), -1 to 1, over a **Fine** (8 m), **Medium** (30 m) or **Broad** (120 m) neighbourhood. |
| **Cavity** | How enclosed the ground is by terrain around it, 0 open to 1 deep in a hollow, within 15, 50 or 150 m. |
| **Flow area** | The area draining through the ground, as a power of ten of m²: 4 is a hectare (rills), 6 a square kilometre (streams). Routed over the lake-filled surface, so water leaves basins through their outlets. |
| **Wetness** | Where water collects and lingers: high flow, flat and low ground. |
| **Water depth** | Depth of the sea or lake over the ground, m; 0 on dry land. |
| **Shore distance** | Metres to the nearest water edge: positive on land, negative under water. |
| **Deposits** | Where hydraulic erosion laid sediment down: fans, valley floors, river bars. 0 to 1 of the map's 98th percentile. |
| **Wear** | Where hydraulic erosion cut the ground away: channels, gullies, scoured rock. |
| **Talus** | Where thermal erosion piled loose material at the foot of slopes: scree. |
| **Layer** | The coverage of a surface below this one: require it, or with **Not**, avoid it. |
| **Noise** | Seeded fractal noise in world space, with its own **Scale (m)**, **Octaves**, **Warp** and **Seed**: patches, clearings, variety. |

A surface with no conditions covers the whole map.

### Breakup

Noise that moves a surface's soft edges, so transitions wander instead of following contour lines.
Solid coverage stays solid.

| Field | Meaning |
|---|---|
| **Amount** | How far the noise moves an edge. |
| **Scale** | Size of the noise features, m. |
| **Octaves** | Detail levels of the noise. |
| **Warp** | Bends the noise into folds. |
| **Seed** | The noise's own seed (offset by the world seed). |

### Post

Applied after the conditions and the breakup, in this order.

| Field | Meaning |
|---|---|
| **Expand** | Grows (positive) or shrinks (negative) the coverage, m. |
| **Blur** | Softens the coverage, m. |
| **Contrast** | Sharpens soft edges toward a hard line. |
| **Opacity** | The surface's overall strength. |

### Preview only

How the Creator shows the surface. None of this is exported.

| Field | Meaning |
|---|---|
| **Material** | The generated PBR material shown: grass, forest floor, dirt, mud, sand, gravel, pebbles, rock, cliff or snow. Tileable, made in the Creator from noise; its colour is only a hint in the manifest. |
| **Tint** | Multiplies the material's colour. |
| **Tiling (m)** | Metres one texture repeat covers. |
| **Height blend** | How much the material's relief decides the transition: pebbles poke through sand, snow fills hollows first. |

The preview landscape uses the engine's own terrain stack, exactly as an imported one does: one
landscape material with a paint-only slot per surface, the masks written from the rules.

## Water preview

The sea and the lakes are drawn with a water material made for large water: four wave octaves that
calm with distance, depth read from the terrain (colour, absorption, shore foam and lines of foam rolling
toward the beach), the sky's reflection and the sun's glint. It is only for the preview: nothing of it is
exported. The **Stage** menu (top right of the viewport) holds it:

### Preview quality

| Option | Meaning |
|---|---|
| **Draft** | A 257² landscape with 512² surface masks: fast while editing. |
| **Fine** | A 513² landscape with 1024² surface masks. |

### Water look

| Field | Meaning |
|---|---|
| **Ocean**, **Tropical**, **Alpine lake**, **Murky** | Presets: colours, clarity, waves and foam. |
| **Clarity (m)** | Metres of visibility: higher sees deeper. |
| **Wave size (m)** | Metres across the main wave pattern. |
| **Wave strength** | How strongly the waves bend the surface. |
| **Wind (°)** | The compass direction the wind blows toward (0 north = -Z, 90 east = +X). |
| **Wind speed** | How fast the waves travel. |
| **Foam** | Foam at the shore and on crests. |

**Show** switches the **Water**, the physical **Sky** and the **Grid**; **Sun** turns and raises it.

## Map

The top-down view. **Height** (a hillshade with the water), **Surfaces** (each surface in its colour,
composited as the export weights them), **Selected surface** (its coverage), **Water** (sea and lake
depths), the four classic masks and the fields: **Aspect**, **Cavity**, **Flow area**, **Shore distance**,
**Deposits**, **Wear**, **Talus**.

## Export

What **Generate & export** writes. Every option here changes the files (and the export hash an editor
re-applies on); none changes the preview.

### Heightmap

| Field | Meaning |
|---|---|
| **Resolution** | Height samples per side, 2^n + 1 (Unity's terrain sizes). |
| **OpenEXR heights** | Also write 32-bit float heights in metres (`<name>_height.exr`), for Houdini, Gaea or Blender. |

Always written: `<name>_height.png` (16-bit greyscale) and `<name>_height.r16` (headerless little-endian
16-bit RAW, Unity and Unreal), normalised over the manifest's `minHeight`..`maxHeight`. Heights are
vertex-aligned: sample (0, 0) sits on the -X/-Z corner.

### Surface maps

| Field | Meaning |
|---|---|
| **Splat resolution** | Texels per side of the splat and weight maps. |
| **RGBA splatmaps** | `<name>_splat_<k>.png`: four surfaces' normalised weights per image, in stack order (base first): Unity alphamaps, Godot, custom shaders. Unused channels are 0. |
| **Weight maps** | `<name>_weight_<index>_<name>.png`: one 8-bit greyscale weight map per surface: Unreal weight-blended layers, Gaea, Blender. |

At every texel the weights sum to exactly 255, so any engine can blend them in its own layer order.
Splat and weight maps are texel-centred over the map square; row 0 is the -Z edge, column 0 the -X edge.

### Data masks

0 to 1 greyscale, the heightmap's resolution and orientation.

| Mask | Meaning |
|---|---|
| **Slope** | 0 flat to 1 vertical (degrees / 90). |
| **Curvature** | 0.5 flat; brighter on ridges and crests, darker in gullies and valley floors. |
| **Flow** | Where water runs: the pipe model's discharge, or flow accumulation when no pipe pass ran. Relative to the map. |
| **Wetness** | Where water collects and lingers: high flow, low slope, low ground. |
| **Aspect** | The direction the ground faces / 360 (0 north, 0.25 east). |
| **Cavity** | How enclosed the ground is, 50 m neighbourhood. |
| **Deposits** | Sediment hydraulic erosion laid down. |
| **Wear** | Ground hydraulic erosion cut away. |
| **Talus** | Material thermal erosion piled at slope feet. |
| **Water** | 1 under the sea or a lake, 0 on land. |

### Package

| Field | Meaning |
|---|---|
| **16-bit masks** | Data masks at 16 bits rather than 8. |
| **One zip** | Download a single `<name>.zip` rather than separate files. |

`<name>` is the asset's name (`untitled` on Scratch). Saved assets sync to the editor with fixed
`world_*` names.

### Manifest

`<name>.json` names every file. Its `output`:

| Key | Meaning |
|---|---|
| `format`, `version` | `"cleo-world"`, `2`. |
| `resolution`, `size` | Height samples per side; world units across. |
| `minHeight`, `maxHeight` | World heights of a 0 and a 1 heightmap sample. |
| `seaLevel` | Sea level, world units. |
| `heightmap` | `{ png, raw, exr?, bits, min, max, sampling }`. |
| `splat` | `{ resolution, files, weights: "normalized", sampling }`. |
| `layers` | Bottom to top: `{ id, name, index, splat: { file, channel: "r"/"g"/"b"/"a" }, weightmap, coverage, kind, color }`. `kind` and `color` are hints only. |
| `masks` | Per mask: `{ file, bits, meaning }`. |
| `water` | `{ seaLevel, lakes: [{ level, area, bounds: [xMin, zMin, xMax, zMax] }] }`, world units. |
| `exportHash` | A hash of everything that decides the files: an importer re-applies when it changes. |
| `orientation` | Row 0 is the -Z edge, column 0 the -X edge. |

The rest of the sidecar (`params`, `seed`) regenerates the files bit for bit.

## Limits

A heightfield cannot hold an overhang. Steep cliffs read as smeared vertical walls; place rock meshes on
the slope mask for real overhangs. The engine draws at most 16 surfaces on one landscape (the base and
15 paint channels); the Creator stops there too.
