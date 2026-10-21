# Valley example generator

Builds `editor/public/examples/valley/`, the engine's example game: the souls content of `tools/soulsDemo/build.mjs` set in an outdoor mountain valley.

```sh
python tools/valley/prepare.py                          # textures: build/ -> build/valley_prepared/
node --max-old-space-size=12288 tools/valley/build.mjs  # writes the example (~200 MB)
npm --prefix editor run examples:list                   # refreshes the gallery index
npx vitest run tests/valleyProject.test.ts tests/valleySouls.test.ts
```

The source art in `build/` is gitignored, so this generator is run by hand and its output is committed.

## Inputs (`build/`)

| File | Becomes |
|---|---|
| `valley_height_4097_16bit.png` | The landscape. It covers the whole 2048 m map; every second sample is kept, giving a 2049² grid at 1 m spacing. |
| `terrain_textures/brown_mud_leaves_01_1k` | Ground, the base surface. |
| `terrain_textures/rock_05_1k` | Rock slot: slopes of 36° and steeper. |
| `terrain_textures/snow_02_1k` | Snow slot: above 250 m, on slopes up to 42°. |
| `terrain_textures/rocky_trail_02_1k` | Trail slot: paint-only. It is masked along the reference's road splines. |
| `foliage/grass_medium_01_1k.gltf` | Three "Meadow Grass" patches, each 5–6 clumps. |
| `foliage/realistic_pine.glb` | "Pine": 477k triangles, decimated with the editor's QEM into three levels. |
| `props/house` | Old House, decimated to 35%. |
| `props/long_house` | Long House, from the artist's LOD1. |
| `props/silo` | Granary. |
| `props/windmill` | Windmill. Its sails spin via `ValleyWindmill.ts`. |

## Files

- `layout.mjs` holds every position from the map's technical reference: spawn, pads, roads, gate plaza and sun. Heights are always sampled, never stored here.
- `heights.mjs` decodes the PNG with the engine's `heightmapIO.ts`.
- `landscape.mjs` builds the landscape material, the trail mask, and the CPU surface weights. The weights come from the engine's `terrainLayers.ts`, so the pre-baked foliage respects the same rules the shader draws.
- `foliage.mjs` builds the grass patches, the pine levels and the seeded scatter. Placement is pre-baked because opening a scene never scatters.
- `props.mjs` handles the FBX props: assimp to parts, with scaling. Some files carry no unit stamp, so those props are sized to a stated height. It also measures the windmill hub.
- `water.glsl` / `water.mjs` hold the pond's water: a transparent forward custom material (waves from a generated tiling normal map, Fresnel reflection of the pond's light probe, a sun glint, refraction with depth absorption, shore foam and a soft edge) and its uniforms. `compileCustomWgsl.ts` translates it to WGSL at build time (through `vite-node`), so a published WebGPU game can render it.
- `meshes.mjs` contains the part pipeline. It flips glTF V, leaves tangents for `Geometry` to rebuild, rounds values for JSON, and builds convex hulls.
- `build.mjs` assembles everything around `writeProject` from `tools/soulsDemo/build.mjs`.

## Not built

The reference's `valley_outdoor.glb` is not in `build/`, so the following are missing:

- the dungeon façade and tunnel
- the dungeon trigger

The fog gate closes the cliff notch instead, and the Hollow Warden waits in the gate plaza.
