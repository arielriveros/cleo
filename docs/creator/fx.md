# FX Creator

Simulate fire, smoke or an explosion on a voxel grid, watch it live in 3D, and export a tileset
flipbook a particle system plays.

The **Viewport** runs the simulation continuously and draws it as a real engine volume, lit by the
scene's sun and hidden behind the ground like anything else in a game. Every parameter change reaches
the next simulation step, so there is nothing to press to see it; only the region size, **Voxel size**
and **Seed** start the simulation over. Drag to orbit, right-drag to pan (the mouse is captured while you
drag), scroll to move closer. The move / rotate / scale buttons top-right of the viewport are the editor's.

The **left** panel is the scene's composition: what is selected, the simulation region, the sun (the one
light the effect is shaded with, in the viewport and in the bake), sky, fire light, wind, ground, bodies
and how the viewport renders. The **right** panel is the effect itself. Both have whole-panel presets at
the top and a **Presets ▾** menu on each section, which only changes that section.
**Pause**, **Restart** and the speed menu control the live simulation; a burst (a **Duration** above 0)
replays by itself once it has faded.

The solver runs as GPU compute when the engine's device has it (the WebGPU backend), and otherwise as
the CPU solver in a background worker, so the editor stays responsive either way.

**Bake flipbook** runs the offline simulation from the start (warm-up, capture, loop blend) and fills the
**Flipbook** and **Atlas** panels; **Export flipbook** writes the atlas, the `.tileset` and the sidecar.

The solver is an Eulerian gas solver: semi-Lagrangian advection, a Jacobi pressure projection that keeps
the flow incompressible, vorticity confinement to restore the swirls the grid smooths out, and a
combustion model where fuel above the ignition temperature burns into heat and smoke (Stam 1999;
Fedkiw, Stam and Jensen 2001; Nguyen, Fedkiw and Jensen 2002). Units are voxels and seconds.

## Domain

The simulation region: a box of voxels the gas lives in. Select **Simulation region** and drag the square
handles on its faces to resize it (Alt resizes about the centre, Ctrl snaps), or type the size here.

| Field | Meaning |
|---|---|
| **Voxel size** | Metres per voxel: the detail. Halving it gives eight times the voxels. The emitter's speeds and the turbulence are in voxels, so a finer grid also makes the same settings smaller and slower in the world. Past 2.5 million voxels the size is raised to fit, and the toolbar's count shows the grid actually used. The CPU solver is practical up to about 250 000 voxels. |

## Emitter

Where fuel, heat and smoke enter the domain.

| Field | Meaning |
|---|---|
| **Shape** | A sphere, or a flat disc one voxel thick. |
| **Radius** | As a fraction of the domain width. |
| **Across** / **Deep** | Where the emitter sits across the region's width and depth: 0.5 is the middle. Select **Emitter** and drag the move gizmo to place it by hand. |
| **Height** | Where the emitter sits, as a fraction of the domain height. |
| **Fuel** | Fuel the emitter holds its volume at. |
| **Heat** | Temperature the emitter holds its volume at; above **Ignition** the fuel burns. |
| **Smoke** | Smoke added directly, before any burning. |
| **Speed** | Upward velocity the emitter imposes. |
| **Turbulence** | Noise velocity stirred into hot gas. |
| **Turbulence scale** | Noise features across the domain. |
| **Duration** | How long the emitter runs; 0 keeps it on (a flame), a short burst makes an explosion. |
| **Noise** | Per-voxel, time-varying jitter of the fuel, heat and speed the emitter holds: flicker and a ragged source instead of a perfect ball. |

## Combustion

How fuel burns once it is hot enough.

| Field | Meaning |
|---|---|
| **Ignition** | Temperature above which fuel burns. |
| **Burn rate** | Fuel burned per second once ignited. |
| **Heat release** | Temperature released per unit of fuel burned. |
| **Smoke yield** | Smoke left per unit of fuel burned. |
| **Expansion** | Burning gas expands: the pressure solve is given that much outward flow per unit of fuel burned, so a fireball blooms outward instead of only rising. |
| **Flame shape** | How much the fire is the thin sheet where fuel is burning right now (the flame field, as in Houdini Pyro and EmberGen) rather than all hot gas. 0 is the soft glowing blob; toward 1 flames become thin, licking sheets. |
| **Flame lifetime** | How long the flame field lasts after fuel at a point stops burning. Shorter gives sharper, shorter tips. |
| **Flicker** | Fuel pulses per second: a candle's or torch's rhythm. 0 is steady. |
| **Blast** | A pressure pulse at the emitter for the first tenth of a second: an explosion's shock, blooming the fireball outward. |

## Forces

What moves the gas besides its own momentum.

| Field | Meaning |
|---|---|
| **Buoyancy** | Hot gas rises. |
| **Smoke weight** | Smoke sinks. |
| **Vorticity** | Confinement strength: higher keeps more curl and detail. |
| **Wind** | A steady push along +X. |
| **Disturbance** | Random velocity kicks in hot or smoky gas, one per block, re-seeded every interval. Breaks smooth sheets into tongues and billows, the detail real fire and smoke have and a grid smooths away. |
| **Disturbance size** | The size of those blocks, in metres. |
| **Disturbance interval** | Seconds between re-seeds: shorter is busier. |
| **Shredding** | Stretches the flow along hot edges, pulling flames and wisps into thin licks. |
| **Settling** | Dust falling through the air at its own speed, in metres per second. |
| **Ground drag** | Slows gas in the bottom voxels, so ground-level dust and smoke spread and hug the floor. |

## Dissipation

How heat, smoke and motion fade.

| Field | Meaning |
|---|---|
| **Cooling** | How fast temperature falls. Shorter flames cool faster. |
| **Smoke fade** | How fast smoke thins out. |
| **Velocity damping** | How fast motion settles. |
| **Radiative cooling** | Hot gas also cools as T⁴, so the hottest parts cool fastest: short, sharp, ragged flame tips. |
| **Diffusion** | Smoke and heat spreading into the air around them, so smoke thins as it spreads rather than only fading. |
| **Condensation** | Steam: the emitter breathes out invisible vapour, which turns into visible droplets where it cools below the **Dew point** and evaporates again above it. Steam then appears a little above the vent and vanishes as it mixes. 0 is off. |
| **Dew point** | The temperature below which the vapour becomes visible. |

## Simulation

Time stepping and the pressure solve.

| Field | Meaning |
|---|---|
| **Frame time** | Simulated seconds per flipbook frame; the flipbook plays at 1 / this. |
| **Substeps** | Solver steps per frame. More is more stable at high speeds. |
| **Pressure iterations** | Iterations of the pressure solve per step. More keeps the flow closer to incompressible. |
| **Pressure solver** | Jacobi, or red-black SOR: Gauss-Seidel with over-relaxation, warm-started from the previous step's pressure. SOR reaches the same incompressibility in far fewer iterations. The live preview always uses it. |
| **Boundaries** | Closed walls on every side but the top, or open air: gas leaves through the sides instead of piling against invisible glass. |
| **Advection** | How the flow carries the smoke, heat and fuel. Semi-Lagrangian is plain and slightly blurry; MacCormack measures that blur with a backward pass and corrects it, keeping much sharper detail at the cost of two extra passes. |
| **Warm-up frames** | Frames simulated before the first captured one, so the fire is established. |
| **Seed** | The turbulence's seed. |

## Flipbook

How frames are captured and laid out.

| Field | Meaning |
|---|---|
| **Frames** | Frames in the flipbook. The atlas is the squarest grid that holds them. |
| **Tile size** | Pixels per frame. |
| **View** | The camera: front, side, top, or an angle around the vertical axis (**Yaw**). Orthographic, framing the whole domain. |
| **Loop blend** | Frames rendered past the end and cross-faded into the start, so the flipbook loops without a pop. 0 plays once (an explosion). |

## Look

How the volume is shaded, in the viewport and in the baked tiles.

| Field | Meaning |
|---|---|
| **Smoke colour** | Albedo of the smoke. |
| **Density** | Extinction per unit of smoke: how opaque it is. |
| **Fire colour from** | The gradient below, or black-body radiation: the colour a body glows at each temperature, with brightness rising as T^4, so a flame's cool edges fade to deep red. |
| **Fire colour** | Colour by temperature, from ignition (left) to the hottest (right). |
| **Coolest flame** / **Hottest flame** | Black-body temperatures, in kelvin, at ignition and at the top of the emission range. Wood fires run roughly 900 to 1500 K, gas burners hotter. |
| **Emission** | Brightness of the fire. |
| **Emission range** | Temperature span the fire colour covers above ignition. |
| **Ambient** | Light reaching smoke in its own shadow. |
| **Anisotropy** | How directionally the smoke scatters light (Henyey-Greenstein). Above 0 it scatters forward, so smoke between you and the sun gets a bright rim; 0 scatters evenly. |
| **Scattering octaves** | Approximates light bouncing several times inside the smoke (Wrenninge's octaves), so thick smoke is not flat grey in its core. 1 is single scattering. |
| **Fire glow** | How strongly the fire lights the smoke around it, so smoke above a flame glows orange. |
| **Detail** | Procedural noise that erodes the smoke below the size of a voxel, drifting upward with time. |
| **Detail scale** | How fine that noise is: features per ten voxels. |
| **Fire intensity** | Fire brightness relative to the smoke. Above 1 the fire outshines lit smoke and drives bloom in the viewport; a bake rolls it off smoothly into the tiles. |
| **Albedo** | The share of the light the smoke stops that it scatters rather than absorbs: near 1 bright steam, low values dark soot. |
| **Powder** | Dark edges on dense smoke facing the light (the Beer-Powder effect of real clouds and billows). |
| **Sky occlusion** | How much the smoke above shades the sky light below it, darkening the undersides of plumes. |

The detail noise rides the flow: it is sampled where each bit of gas came from (two sets of advected noise
coordinates, cross-faded so their resets are never seen), so it stretches and swirls with the smoke.

## Select

What the viewport's gizmos act on. Click a body, the emitter or the region in the viewport, or pick it here.
**W**, **E** and **R** switch between move, rotate and scale; **X** flips the gizmo between world and local
axes; **F** frames the selection; **Delete** removes a selected body; **Escape** clears the selection. The
region is resized with its face handles; the emitter moves and scales (its radius).

## Region

The simulation region: the box of voxels the gas lives in, and where it stands.

| Field | Meaning |
|---|---|
| **Region size** | Width, height and depth of the box, in metres. Part of the effect: the bake uses it. A bigger box gets more voxels at the same **Voxel size**, so it costs more. |
| **Region position** | The centre of the region's floor, in metres; preview only, as a bake frames the region itself. Dragging a face handle moves it so the opposite face stays put. |

## Sun & sky

The sun is the one light the effect is shaded with: its direction lights the viewport and the baked tiles alike. Its strength and colour, the ambient and the sky are the stage's.

| Field | Meaning |
|---|---|
| **Sun yaw** / **Sun elevation** | The direction the sunlight comes from: it lights the scene and shades the smoke, in the viewport and in the bake. |
| **Sun illuminance** | Direct sunlight, in lux. A clear noon is about 100 000 lux. |
| **Sun temperature** | The sun's colour as a colour temperature: about 2000 K at sunset, 5800 K at noon. |
| **Ambient light** | Flat light from every direction, in lux. |
| **Physical sky** | A real atmosphere behind the effect, which also lights the smoke from the sky. |
| **Auto exposure** | Let the camera adapt to the scene's brightness, as a game camera does. Off, **Exposure** sets it by hand. |
| **Exposure** | Manual exposure, EV100. |

## Fire light

A point light that follows the flame: placed at its glowing centre, as bright as the flame is big, so the fire lights the ground and the bodies around it.

| Field | Meaning |
|---|---|
| **Fire lights the scene** | Add the light. |
| **Brightness** | Lumens with the whole flame burning. |
| **Flicker** | Random brightness changes, smoothed so they read as fire rather than noise. |

## Wind

Wind across the stage: an engine Wind node, and a force on the gas that pulls it toward the wind's speed where there is gas to move.

| Field | Meaning |
|---|---|
| **Scene wind** | Turn the stage's wind on. |
| **Direction** | Where it blows toward, degrees counter-clockwise from +X seen from above. |
| **Strength** | Wind speed, metres per second. |
| **Gustiness** | How much of the wind comes and goes with the gusts. 0 is steady. |
| **Gust size** | Metres between gust crests. |
| **Gust speed** | How fast the gusts travel. |

## Ground

What the effect stands on.

| Field | Meaning |
|---|---|
| **Grid** | The editor grid on the ground. |
| **Ground plane** | A matte floor, for the fire light and shadows to land on. |

## Rendering

How the viewport draws the volume.

| Field | Meaning |
|---|---|
| **Quality** | Low runs fewer pressure iterations, marches the volume in longer steps at half the screen resolution and updates the self-shadowing less often, for big grids or slower machines. High uses finer steps at full resolution. A bake always uses the effect's own values. |
| **Ground shadow** | The effect casts a shadow on the ground: the light reaching the floor through the smoke toward the sun, drawn as a decal. |
| **Shadow strength** | How dark that shadow can get. |
| **Temporal accumulation** | Each frame casts one jittered ray per pixel with longer steps, and blends it with the previous frames reprojected through where the smoke is: the volumetric clouds' and TAA's technique. Much cheaper per frame for the same settled quality; fast changes take a few frames to settle. While the camera moves or a setting changes, the march takes longer steps still and leans on the new frames. |

## Bodies

Static objects the gas flows around, never through: real engine models with physics bodies. Smoke spreads under a lid, eddies behind a wall, and a body casts a shadow into the smoke. Each one has:

| Field | Meaning |
|---|---|
| **In the scene** | Off, the body is hidden and the gas ignores it. |
| **Position** | Its centre, in metres. The effect stands on the origin. |
| **Size** | Full extents. A sphere's diameter is X; a capsule's diameter is X and its overall height Y. |
| **Turn** | Rotation around the vertical axis. |
| **Tilt** | Rotation around the body's own X axis, after the turn. |

## Presets

**Preset** replaces every parameter with a starting point, keeping your seed and preview quality: a
campfire (plain and realistic), torch, smoke plume, explosion burst, candle, bonfire, gas burner, brazier,
chimney smoke, steam vent, smouldering embers, magic fire, fireball, large explosion, muzzle flash and a
dust puff. Each comes with its own region size and voxel size for its scale.

## Output

The atlas is straight-alpha RGBA, frames left to right then top to bottom. The `.tileset` describes its
grid; `fx.json` carries a `particleFlipbook` block (columns, rows, frames, FPS) for a particle system's
**Render** module.

## Licensing note

The solver is written from the published papers above. A US patent (7,472,046) describes a solver built
from the same pieces; it has not been reviewed, and a freedom-to-operate check is needed before this
solver ships in a product (see the research plan, B6).
