# World Creator

Build a landscape from a stack of landform layers, erode it, and export the heightmap. The stack is
applied top to bottom, each layer reading the height the ones above it made, and nothing is baked:
every change re-evaluates the whole stack. The live preview runs at up to 257 x 257 on a real engine
landscape in the viewport and on the **Map**; **Generate & export** runs the full resolution.

Heights are a fraction of the **Height scale** (0 the lowest ground, 1 a full-height peak; layers may
overshoot and erosion may cut below 0). Positions are map coordinates, 0 to 1 across the world, with
(0, 0) the -X/-Z corner, the same orientation the engine's heightmap import uses.

## World settings

The frame every layer and pass works in.

| Field | Meaning |
|---|---|
| **Resolution** | Samples per side of the export, 2^n + 1 to match the engine's terrain grids. |
| **World size** | World units across the map. |
| **Height scale** | World units of a height of 1. |
| **Seed** | The world's seed. Every layer and erosion pass derives its randomness from it; change it for a new variation of the same design. |
| **Sea level** | Normalised height of the sea, for the map's water tint. |

## Landforms

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
| **Thermal** | Material slumps off any slope steeper than the **Talus angle**, softening cliffs into scree. Conserves material. |
| **Hydraulic (droplets)** | Many single raindrops roll downhill, eroding where they speed up and depositing where they slow: gullies and alluvial fans. |
| **Hydraulic (virtual pipes)** | A shallow-water simulation (Mei et al. 2007): rain flows between cells through virtual pipes and carries sediment. Runs on the GPU when available. Also produces the flow and wetness masks. |

Erosion works in grid cells, so the same settings erode a 2049 export more finely than the 257 preview;
check the full-resolution result before committing to a look.

## Masks

Exported beside the heightmap, each 0 to 1, in the heightmap's orientation.

| Mask | Meaning |
|---|---|
| **Slope** | 0 flat to 1 vertical. |
| **Curvature** | 0.5 flat; brighter on ridges and crests, darker in gullies and valley floors. |
| **Flow** | Where water runs: the pipe model's discharge, or flow accumulation when no pipe pass ran. |
| **Wetness** | Where water collects and lingers: high flow, low slope, low ground. |

## Limits

A heightfield cannot hold an overhang. Steep cliffs read as smeared vertical walls; place rock meshes on
the slope mask for real overhangs.
