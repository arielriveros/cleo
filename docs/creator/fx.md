# FX Creator

Simulate fire, smoke or an explosion on a voxel grid, render it from a chosen view, and export a tileset
flipbook a particle system plays. **Simulate** runs the solver (GPU compute when the engine's device
has it, the CPU solver otherwise), showing frames as they are captured; **Export flipbook** writes the
atlas, the `.tileset` and the sidecar.

The solver is an Eulerian gas solver: semi-Lagrangian advection, a Jacobi pressure projection that keeps
the flow incompressible, vorticity confinement to restore the swirls the grid smooths out, and a
combustion model where fuel above the ignition temperature burns into heat and smoke (Stam 1999;
Fedkiw, Stam and Jensen 2001; Nguyen, Fedkiw and Jensen 2002). Units are voxels and seconds.

## Domain

The voxel grid the gas lives in.

| Field | Meaning |
|---|---|
| **Resolution** | Voxels across X and Z. Cost grows with the cube: 48 is quick, 128 is detailed. The CPU solver is practical up to about 64. |
| **Height ratio** | Domain height over width. Flames want 1.5 to 2. |

## Emitter

Where fuel, heat and smoke enter the domain.

| Field | Meaning |
|---|---|
| **Shape** | A sphere, or a flat disc one voxel thick. |
| **Radius** | As a fraction of the domain width. |
| **Height** | Where the emitter sits, as a fraction of the domain height. |
| **Fuel** | Fuel the emitter holds its volume at. |
| **Heat** | Temperature the emitter holds its volume at; above **Ignition** the fuel burns. |
| **Smoke** | Smoke added directly, before any burning. |
| **Speed** | Upward velocity the emitter imposes. |
| **Turbulence** | Noise velocity stirred into hot gas. |
| **Turbulence scale** | Noise features across the domain. |
| **Duration** | How long the emitter runs; 0 keeps it on (a flame), a short burst makes an explosion. |

## Combustion

How fuel burns once it is hot enough.

| Field | Meaning |
|---|---|
| **Ignition** | Temperature above which fuel burns. |
| **Burn rate** | Fuel burned per second once ignited. |
| **Heat release** | Temperature released per unit of fuel burned. |
| **Smoke yield** | Smoke left per unit of fuel burned. |

## Forces

What moves the gas besides its own momentum.

| Field | Meaning |
|---|---|
| **Buoyancy** | Hot gas rises. |
| **Smoke weight** | Smoke sinks. |
| **Vorticity** | Confinement strength: higher keeps more curl and detail. |
| **Wind** | A steady push along +X. |

## Dissipation

How heat, smoke and motion fade.

| Field | Meaning |
|---|---|
| **Cooling** | How fast temperature falls. Shorter flames cool faster. |
| **Smoke fade** | How fast smoke thins out. |
| **Velocity damping** | How fast motion settles. |

## Simulation

Time stepping and the pressure solve.

| Field | Meaning |
|---|---|
| **Frame time** | Simulated seconds per flipbook frame; the flipbook plays at 1 / this. |
| **Substeps** | Solver steps per frame. More is more stable at high speeds. |
| **Pressure iterations** | Jacobi iterations per step. More keeps the flow closer to incompressible. |
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

How the volume is shaded when it is rendered into a tile.

| Field | Meaning |
|---|---|
| **Smoke colour** | Albedo of the smoke. |
| **Density** | Extinction per unit of smoke: how opaque it is. |
| **Fire colour** | Colour by temperature, from ignition (left) to the hottest (right). |
| **Emission** | Brightness of the fire. |
| **Emission range** | Temperature span the fire colour covers above ignition. |
| **Light yaw** / **Light elevation** | Direction of the single light that shades the smoke. |
| **Ambient** | Light reaching smoke in its own shadow. |

## Output

The atlas is straight-alpha RGBA, frames left to right then top to bottom. The `.tileset` describes its
grid; `fx.json` carries a `particleFlipbook` block (columns, rows, frames, FPS) for a particle system's
**Render** module.

## Licensing note

The solver is written from the published papers above. A US patent (7,472,046) describes a solver built
from the same pieces; it has not been reviewed, and a freedom-to-operate check is needed before this
solver ships in a product (see the research plan, B6).
