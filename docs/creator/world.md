# World Creator

Build a landscape as a node **Graph**, erode it, texture it with a stack of rule-placed surfaces, and
export it in the formats every engine reads. Nothing is baked: every change re-runs only the nodes it
affects. The preview runs on a real engine landscape in the viewport (257² or 513², see
[Preview quality](#preview-quality)) and on the **Map**; **File ▸ Generate & export** runs the full
resolution. The **Graph** and the **Map** sit side by side below the viewport; **Node** (the selected
node), **World** (settings, lakes and the world presets), **Surfaces** and **Export** are the right dock.
**Edit ▸ Undo** (Ctrl+Z) and **Redo** (Ctrl+Shift+Z or Ctrl+Y) step back and forth through every edit,
paint strokes included.

Heights are a fraction of the **Height scale** (0 the lowest ground, 1 a full-height peak; nodes may
overshoot and erosion may cut below 0). Positions are map coordinates, 0 to 1 across the world, with
(0, 0) the -X/-Z corner, the same orientation the engine's heightmap import uses. North is -Z (the top
of the Map).

## World settings

The frame every node works in.

| Field | Meaning |
|---|---|
| **World size** | World units across the map. |
| **Height scale** | World units of a height of 1. |
| **Seed** | The world's seed. Every node and surface noise derives its randomness from it; change it for a new variation of the same design. |
| **Sea level** | Normalised height of the sea. The sea fills in from the map's edges up to it; the water rules measure from it. |

## World presets

**World presets** (the World tab's header) start a world from one of seven landscapes. Each is built the
way real land is, and the graph it leaves is the recipe to change:

1. A broad, smooth **shape** that says where the land stands high: noise with few octaves, under a ramp or
   a dome. Nothing finer than a valley.
2. **Rivers and valleys**: the shape is where the land rises, and rivers cut it into valleys that join and
   fall to the sea or the map's edge, with ridges left between them. No closed hollows are left.
3. A fine **Erosion filter**: the gullies too small for the simulation's grid.
4. **Finishing**: **Drain** (so the only lakes are the ones meant), then a lake basin where one is wanted.
   Built things such as a **Road** follow ground that a new seed moves, so they are left for you to add.

Each is as large as its landscape is, and as high: its slopes are a real landscape's.

| Preset | Size, relief | What it is |
|---|---|---|
| **Island** | 2 km, 280 m | An island in open sea: a massif off its centre, valleys to a coast of bays and headlands, a lake in a valley spilling to the sea. What the Island example is built from. |
| **Coastal range** | 4 km, 900 m | Mountains falling straight to the sea, their valleys drowned into long bays. |
| **Alpine massif** | 8 km, 2.2 km | High mountains: sharp ridges, deep valleys, snow above about 1800 m. |
| **Rolling hills** | 4 km, 170 m | Rounded hills and broad vales, a stream in every fold. |
| **Mesa desert** | 4 km, 350 m | Tablelands under a hard caprock, cut back by canyons into mesas and buttes. |
| **Eroded highlands** | 8 km, 900 m | Old highlands falling to a coast: broad worn ridges, long branching valleys. |
| **Badlands** | 1 km, 70 m | Soft clay cut into a maze of steep rills and sharp ridges. |

Picking a preset replaces the terrain and the world settings. It brings the surfaces that suit it (desert
sand for the mesas, snow on the massif) unless you have edited the surfaces, which then stay. It keeps the
seed (every preset drains whatever the seed, so a new seed is a new variation), the export resolution,
the export settings and the painted masks. **Reset** applies the current preset again.

### Proportions

Real relief is small against its extent: mountain flanks average 25 to 35 degrees, hill country 5 to 15.
A world whose **Height scale** is close to its **World size** stands up in needles however it is eroded;
keep the highest ground to a third of the map's width for mountains and a twentieth for hills. Then a
mountain wants its map several kilometres across, and a 2 km map holds a hill or an island.

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

## Graph

The terrain is a graph of nodes wired output to input; the **Output** node's height is the world.
Ports are typed: **heights** (blue) and **masks** (amber, 0 to 1). Drag from an output to an input to
wire them (an input takes one wire; a wire that would close a loop is refused). Right-click or
double-click the canvas, or use **+**, to add a node; right-click a node to duplicate, switch off or
delete it; Delete removes the selection. The dot on a node's title switches it off: it then passes its
input through. **Tidy** lays the graph out in columns.

Each node shows a thumbnail of its output and a badge: how long it took, **Pending** while a live edit
skips it, **Not connected** when nothing the Output reads comes from it (it does not run), or
**Finer than preview** when an erosion filter's finest gullies are smaller than the preview grid shows.

Moving and renaming nodes is layout: it re-runs nothing and never changes the export.

Documents from before the graph open as one chain (each landform, then each erosion pass, into the
Output) that produces exactly the same world.

### Shapes

Base terrains made from nothing. Each carries its exact slope, which the erosion filter steers by.

| Node | What it does |
|---|---|
| **Fractal noise** | fBm, ridged or billowed gradient noise. *fBm* rolls, *Ridged* makes sharp crests, *Billow* rounded hills. **Warp** folds the pattern. |
| **Continent** | Ocean floor, a coast, plains and highlands from one low-frequency field. **Coast at** decides how much is sea. |
| **Ramp** | A straight ramp across the map, or a round dome whose centre you drag on the Map. |
| **Constant** | One height everywhere. |

### Landforms

Hand-placed features, each changing the height wired into it. Their **Change** output is a mask of
where they changed the ground. **Strength** fades any of them from off (0) to full (1).

| Node | What it does |
|---|---|
| **Noise blend** | Fractal noise blended into the height by its **Blend** mode. |
| **Mountain** | A peak with ridged flanks around a centre you drag on the map. |
| **Ridge** | Raised ground along a spline. |
| **Valley** | Lowered ground along a spline. |
| **River** | Carves a channel along a spline down to a bed that runs from **Bed at source** to **Bed at mouth**. Never raises the ground. |
| **Road** | Flattens a strip along a spline to an evenly graded road, with cut-and-fill shoulders. |
| **Plateau / cliff** | Lifts the ground inside a radius to a level; a small **Edge** makes a cliff. |
| **Terraces** | Steps the heights inside a band, like strata. |
| **Crater / lake** | A bowl with a raised rim. |
| **Coast / beach** | Sinks the land beyond a shoreline to a shelf under the sea, with a flattened beach just above sea level. |

Splines and centres are edited on the **Map**: select the node, drag its handles, double-click to add a
spline point, Alt+click to remove one.

### Combine

**Combine** joins a **Base** and a **Layer** height: *Add*, *Subtract*, *Max*, *Min*, *Multiply* or
*Replace*, at a **Strength**, and through a **Mask** when one is wired (the operation applies where the
mask is 1).

### Masks

| Node | What it does |
|---|---|
| **Remap** | Maps a height range onto another, with a **Curve** (above 1 flattens lowlands and steepens peaks). |
| **Height mask** | 1 inside a band of heights, fading over **Falloff**. |
| **Slope mask** | 1 inside a range of steepness, degrees. |
| **Invert** | 1 minus the mask. |
| **Blur** | Softens a height or a mask over a radius in metres. |
| **Mask combine** | Joins two masks: multiply (both), add, subtract, max (either), min. |
| **Normalize** | Stretches a height to 0..1 (lowest to highest): any height as a mask. |

### Erosion filter

Branching gullies and sharp ridges, after Rune Skovbo Johansen's erosion filter
([blog](https://blog.runevision.com/2026/03/fast-and-gorgeous-erosion-filter.html), MPL 2.0). It
simulates no water: every point is worked out on its own from the slope wired into it, layering
octaves of stripes that run downhill (Phacelle noise), each octave branching off the one before. That
makes it fast enough to drag live, and the same at any resolution. Its **Ridges** output is the ridge
map (0 in creases, 1 on crests); **Gullies** is how deep it cut. The last filter before the Output feeds
the surfaces' **Ridges** and **Gullies** inputs, and the export masks of those names.

| Field | Meaning |
|---|---|
| **Look** | Presets: *Balanced*, *Soft hills*, *Alpine*, *Badlands*, *Fine detail*. |
| **Gully spacing** | Width of the largest gullies, metres. |
| **Depth** | Gully depth relative to their spacing. |
| **Detail** | How readily finer gullies cut into the ridges and creases of coarser ones. |
| **Octaves** | Levels of ever finer gullies. |
| **Gully shape** | How much of the gullies' rounded shape shows; lower keeps peaks pointy. |
| **Ridge rounding** / **Crease rounding** | Soften the crests between gullies and the gully floors. |
| **Valley level** / **Peak level** | Heights (fractions of the height scale) the filter treats as valley floor and summit: it fades its gullies toward valleys there and toward peaks here. |
| **Seed offset** | A different arrangement of gullies. |

Under **Advanced**: **Persistence** and **Lacunarity** (depth and spacing from one octave to the next),
**Input rounding**, **Rounding per octave**, the **Onset** steepness for gullies to start (and per
octave, and for the ridge map), **Assumed slope** and **Straighten** (how cleanly gullies branch),
**Cell size**, **Normalization**, **Height bias** and **Keep altitude** (cancels the filter's net raise of
peaks and drop of valleys).

Wire masks into **Depth mask**, **Detail mask** or **Peak/valley mask** to vary it across the map: a
painted depth mask erodes only where you paint.

### Rivers and valleys

Fluvial erosion: what gives real land its drainage. Rivers cut down in proportion to the water they carry
and the slope they run on (the stream power law), against the land rising: the height wired in is where
the land rises, and the relief that stands is what the rivers leave of it. Every valley joins a larger one
and falls without a break to the sea or the map's edge; ridges are what is left between them; a river
steepens upstream as the water it carries shrinks, as real rivers do. Hillsides stand no steeper than the
talus angle, crests and creases are rounded by soil creep, and hollows silt up, so no closed hollow is left
to fill with a lake. At the end the land is brought back to the height it was drawn at (its highest
ground), so the relief you set is the relief you get. The solver is Braun and Willett's (2013), as
Cordonnier et al. (2016) and Schott et al. (2023) use it for terrain.

Feed it a broad, smooth shape: it makes the valleys. Fine noise before it only roughens where the rivers
start. The fine gullies come after it, from an **Erosion filter**.

| Field | Meaning |
|---|---|
| **Age** | How long the rivers have cut: 0.2 young (valleys near the outlets, the drawn shape kept), 1 mature, 3 the shape the rivers give. Not a step count: it is measured against the land's own drainage. |
| **Steepest slope** | The steepest a hillside stands, degrees: 35 to 40 for mountains, 20 for soft hills, 50 and more for caprock cliffs. |
| **Rounding** | Metres over which soil creep rounds crests and creases. It also sets how close the smallest valleys lie: a few metres for badlands, tens for mountains, a hundred or more for hills. |
| **Simulation grid** | Samples a side the simulation runs on, whatever the preview or export resolution (see below). |
| **Valley profile** | How fast rivers flatten downstream: higher gives long, flat lower valleys under steep heads. |
| **Channels from** | Drainage area, m², below which the ground barely cuts: more leaves smooth hillsides between fewer, larger valleys; 0 makes every slope a channel. |
| **Basin fill** | How far hollows silt up: 1 leaves no closed hollow; less leaves the deepest as basins. |

Its **Hardness** input (a mask) makes rock resist: 1 erodes at a twentieth of the rate, so a caprock
stands as tablelands over cut-back cliffs. Its **Flow** output is the area draining through each point,
from a thousand square metres (0) to the whole map (1). What it cuts feeds the surfaces' **Wear**.

### Drain

Fills every closed hollow to the level it spills at, so water runs off: the pits an erosion filter leaves,
since it carves without regard to where water goes. Put lakes you want (a crater) after it. The sea and the
map's edge are where water leaves.

### Simulations

| Node | What it does |
|---|---|
| **Thermal erosion** | Material slumps off any slope steeper than the **Talus angle**, softening cliffs into scree. Conserves material. What it piles up is the surfaces' **Talus**. |
| **Hydraulic (droplets)** | Many single raindrops roll downhill, gaining speed as they go, eroding where they can carry more and depositing where they slow: gullies and alluvial fans. What they lay down is **Deposits**, what they cut is **Wear**. |
| **Hydraulic (pipes)** | A shallow-water simulation (Mei et al. 2007): rain flows between cells through virtual pipes and carries sediment. Runs on the GPU for the export when available. Also produces the flow and wetness masks, and Deposits and Wear. |

Their lengths are metres:

| Field | Meaning |
|---|---|
| **Reach** | Thermal: how far scree travels from where it falls. Pipes: how far water runs over the simulation. |
| **Travel** | How far a droplet runs before it is spent. |
| **Brush radius** | How wide a droplet cuts, metres. |

Every simulation, **Rivers and valleys** and **Drain** included, runs on its own **Simulation grid**
(257 to 4097 samples a side), whatever resolution the world is evaluated at: the 257 preview, the 513 fine
preview and a 4097 export erode the same land, and only what the simulation changed is carried to the
evaluated grid (detail drawn before it, finer than its grid, is kept). A finer grid catches smaller
features and takes longer: Rivers and valleys takes a few seconds at 513, about four times that at 1025.
A world saved before the simulation grid existed keeps its look at the resolution it was exported at: its
simulations run on that resolution, their old counts of cells turned into metres.

### Paint mask

A mask you brush on. **New** makes a blank 0..1 mask, **Signed** a -1..1 one; its **Mask** output is the
painted value, its **Height** output the value times **Height amount** (metres): wire it into a Combine
*Add* to raise and lower ground by hand. Switch **Paint** on and brush on the **Map** or straight on the
landscape (the camera stops orbiting while you paint): *Add*, *Erase*, *Smooth* or *Set* to a
**Value**, with **Radius**, **Strength** and **Falloff**; **[** and **]** change the size. **Clear** and
**Fill** cover the whole mask. Masks save with the asset (or, on Scratch, in the browser).

### Output

The world's heights. There is always exactly one.

## Live preview

Dragging a parameter of a shape, a Combine or an erosion filter, or painting a mask, updates the
landscape every frame: with GPU compute (WebGPU) those nodes and everything after them run as compute
kernels at 257², from the outputs of the nodes before them; without it (WebGL 2) the graph's heights
re-run at 129². Simulations (Rivers and valleys and Drain among them) and landforms after the edited node
are skipped while you drag (their badge reads **Pending**): the valleys come back when the edit pauses. When the edit pauses the full preview follows: every node, the fields, the
surfaces and the water. The CPU result is always what the Map, the surfaces and the export use.

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
| **Alpine** | Alpine meadow, seabed, riverbed, scree, gully floors, rock slopes, ridge rock, cliff, shaded snow, snow. |
| **Desert** | Hardpan, desert sand, gravel washes, gully floors, scree, rock slopes, ridge rock, banded cliffs. |
| **Tropical coast** | Lush grass, forest floor, seabed, beach sand, wet sand, mud, rock slopes. |

A world preset (the World tab's header) brings its own surfaces unless you have edited yours (see
[World presets](#world-presets)). **Snow** and **Shaded snow** lie above a height over the sea (1800 m and
1400 m), so hill country has none and a massif's heights are white.

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
| **Ridges** | The erosion filter's ridge map: 1 on the crests between its gullies, 0 in their creases, 0.5 elsewhere. |
| **Gullies** | How deep an erosion filter cut the ground: its gully floors. 0 to 1 of the map's 98th percentile. |
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
**Deposits**, **Wear**, **Talus**, **Ridges**, **Gullies**, and **Selected node** (the selected node's
output). With a Paint mask node selected and **Paint** on, the Map is a canvas: brush on it.

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
| **Ridges** | The erosion filter's ridge map: 0 creases, 0.5 neutral, 1 crests. |
| **Gullies** | How deep erosion filters cut. |
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
