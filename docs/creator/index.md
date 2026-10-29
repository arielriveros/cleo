# Cleo Creator

Cleo Creator is the procedural asset tool that ships beside the Editor. It runs the same engine as the
Editor and a published game, so a preview looks the way the asset will in play, and it is built from the
same app-kit (`applications/app-kit`): the same panels, docking, console, tooltips and renderer
settings.

It has two tools, switched in the top bar:

| Tool | Makes | Exports |
|---|---|---|
| **World Creator** | Landscapes from landform layers and erosion | A 16-bit heightmap (PNG and RAW), slope/curvature/flow/wetness masks, and a JSON sidecar |
| **FX Creator** | Fire, smoke and explosions from a volumetric fluid simulation | A tileset flipbook (RGBA atlas PNG), a `.tileset` asset, and a JSON sidecar with the particle flipbook settings |

Run it with `npm run creator:dev` at the repository root (it serves on port 8081, beside the Editor's
8080).

## Determinism

Every asset is a pure function of its parameters and its seed. The sidecar written beside each export
records both, so the same file regenerates bit-for-bit on the CPU paths. The GPU paths agree with the
CPU to float rounding.

## GPU and CPU

The heavy passes (virtual-pipe erosion, the fluid solver) run as WebGPU compute on the engine's own
device when the renderer runs on WebGPU. On WebGL 2, which has no compute, the CPU reference
implementation runs instead: same method, same results within rounding, slower. Pick the graphics API
on the renderer settings, as in the Editor.

## Using the outputs in the Editor

- **Heightmap:** in Landscape mode, import `world_height.png` (or `.r16`) and enter the **Min** and
  **Max** heights from `world.json` (`minHeight`, `maxHeight`). The masks import as paint layers.
- **Flipbook:** import `fx_flipbook.png` as a texture, then the `.tileset`; in a particle system's
  **Render** module set the texture to the tileset and copy `particleFlipbook` from `fx.json` into its
  flipbook settings (columns, rows, frames, FPS).
