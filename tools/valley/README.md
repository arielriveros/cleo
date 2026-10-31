# Valley example generator

Builds `applications/editor/public/examples/valley/`, the engine's example game: the souls content of `tools/soulsDemo/build.mjs` set in an outdoor mountain valley with a day and night cycle, and a second scene, the Dungeon, entered through the skull cave.

```sh
python tools/valley/prepare.py                          # unzips new downloads; textures: build/ -> build/valley_prepared/
node --max-old-space-size=12288 tools/valley/build.mjs  # writes the example (~240 MB)
npm --prefix editor run examples:list                   # refreshes the gallery index
npx vitest run tests/valleyProject.test.ts tests/valleySouls.test.ts tests/dungeonCollision.test.ts
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
| `terrain_textures/dirt_1k` | Dirt (paint-only noise patches and worn ground about the buildings) and Dirt Road (the lesser roads of `DIRT_ROADS` and the forest tracks). |
| `terrain_textures/clay_plaster_1k`, `coast_sand_02_1k` | Pond Clay under the water and Shore Sand on the bank, painted from the heights about the waterline. |
| `terrain_textures/concrete_rock_path_1k` | Stone Path: from each building to the main road, and paving round the bonfire. |
| `foliage/rock_moss_set_02_1k.gltf` | The dungeon's rubble (four moss rocks). |
| `pine_bark_1k.zip`, `jolcham_oak_bark_01_1k.zip` | Scanned bark (colour, normal, ARM) worn by the spruce (pine bark) and the oaks (oak bark); `prepare.py` writes them to `bark_pine_*` / `bark_oak_*`. |

The Poly Haven downloads may arrive as `.zip` beside these paths; `prepare.py` extracts each once.

### Plants

No plant is an input: every tree, bush and grass clump is made with the Foliage Creator
(`applications/creator`). `creatorFoliage.mjs` lists them, each a Creator preset with a seed and a few
settings: two spruces (the belt at the cliff foot and the valley stands), a highland spruce (beyond
the rim), an oak (about the hamlet and the pond), two meadow grasses and tall grass, two shrubs and a juniper (forest edges,
walls and fences), and the Forest Floor's undergrowth (two leafy bushes and boxwood). `genFoliage.ts`
generates them headless through `vite-node`, with the Creator's own generator, materials and octahedral
impostor bake, and caches the result in `build/valley_creator/`, keyed by the spec and the generator's
source. To change a plant, try it in the Creator's Foliage mode and copy its preset, seed and settings
into `creatorFoliage.mjs`.
| `props/house` | Old House, decimated to 35%, scaled 1.75x so the knight fits its doors from its raised floor. |
| `props/long_house` | Long House, from the artist's LOD1, 10.3 m tall so the knight fits its doors from its raised floor. |
| `props/silo` | Granary. |
| `props/windmill` | Windmill. Its sails spin via `ValleyWindmill.ts`. |
| `props/skull_cave` | The Skull Cave Entrance in the cliff notch: the door to the Dungeon. |
| `props/medieval_dungeon_structure (1).glb` | The Dungeon, at full detail: split into 10 m chunks, its lights read as placement anchors. |
| `wall_textures` | The dungeon's stone: walls, slabs, brick and cobbled floors. Wood and metal keep the structure's own textures. |
| `props/wall_torch_model`, `props/medieval_torch.glb` | Wall-mounted and standing torches. |
| `props/campfire_fire_with_stones.glb`, `props/dungeon_cage.glb`, `props/bookcase.glb`, `props/weapons` | The bonfire and fire pits, cages and braziers, bookcases, racked and dropped weapons. |
| `medieval_knight__sculpture__game_ready.glb` | The player: a Mixamo-rigged knight (shield left out) on its own `Knight` rig, playing the mannequin's clips, animators and blend spaces through a retarget (`knight.mjs`). |
| `fire.png` | The fire tileset: 8 x 4 frames of 128 x 256, the flame on every torch, brazier and fire. |

## Files

- `layout.mjs` holds every position from the map's technical reference: spawn, pads, roads, gate plaza and sun. Heights are always sampled, never stored here.
- `heights.mjs` decodes the PNG with the engine's `heightmapIO.ts`.
- `landscape.mjs` builds the landscape material, the painted masks (seven channels in two slices: trail, forest floor, dirt road, stone path, clay, sand, dirt), and the CPU surface weights. The weights come from the engine's `terrainLayers.ts`, so the pre-baked foliage respects the same rules the shader draws.
- `creatorFoliage.mjs` lists the plants and generates them with the Foliage Creator (`genFoliage.ts`, through `vite-node`); `build.mjs` turns each one's levels, materials and impostor into a library model, library materials and a foliage rule.
- `foliage.mjs` holds the library-asset helpers, the dungeon's moss rocks and the seeded scatter. Placement is pre-baked because opening a scene never scatters.
- `props.mjs` handles the FBX props: assimp to parts, with scaling. Some files carry no unit stamp, so those props are sized to a stated height. It also measures the windmill hub.
- `water.glsl` / `water.mjs` hold the pond's water: a transparent forward custom material (waves from a generated tiling normal map, Fresnel reflection of the pond's light probe, a sun glint, refraction with depth absorption, shore foam and a soft edge) and its uniforms. `compileCustomWgsl.ts` translates it to WGSL at build time (through `vite-node`), so a published WebGPU game can render it.
- `presets.ts` resolves the engine presets the valley's look is made of, through `vite-node`: the Sunny 16
  fixed exposure, the Cinematic lens look and depth of field, the Hazy Summer sky, Sunny clouds, a Breezy wind,
  a Pond / Lake water volume and the Morning Sun (brightened against the valley's ambient). The High quality tier
  and a sky light with cloud shadows complete it. Nothing in the look is hand-tuned; change a preset to change it.
- `houses.mjs` makes the Old House and the Long House enterable. It rasterises each into wall and lintel boxes, merged the way the dungeon's are, under one convex hull for the roof, with the doorways left open; the build logs each house's lowest lintel over its floor. Both stand on a raised floor, so the ground inside is raised to it and eased back to the hillside outside, and the navmesh carves only round the walls.
- `occluders.mjs` fits occluder volumes as thin slabs down the middle of wall colliders, only as tall as the wall is unbroken. They go in the dungeon's walls and in the houses' walls.
- `meshes.mjs` contains the part pipeline. It flips glTF V, leaves tangents for `Geometry` to rebuild, rounds values for JSON, and builds convex hulls.
- `torches.mjs` builds the fire props (wall and standing torches, campfire, cages, candles) and finds walls to hang torches on.
- `dungeon/` builds the Dungeon: `structure.mjs` loads and chunks the structure and opens its sealed doorways; `collision.mjs` rasterises its floors, walls, ceilings and stairs into box colliders (the scene format has no triangle meshes), keeping their number down (cells merged within a tolerance, a pillar one box, a diagonal wall one turned box), and checks the level can be walked; the pillars' boxes go on bodies of their own that the camera sees through; `layout.mjs` holds the zones, fires, enemies, pickups and messages; `props.mjs` the procedural furniture; `scene.mjs` assembles it.
- `knight.mjs` builds the player character: the skinned GLB read headlessly (`tools/exampleKit/skinnedGlb.mjs`), scaled to 1.9 m, one model with a submesh per material, its rig with hand sockets that turn its hand frame into the mannequin's (so the same weapons sit in either fist), and foot IK.
- `build.mjs` assembles everything around `writeProject` from `tools/soulsDemo/build.mjs`.

## Light and time

- **The Time of Day** node (`examples/scripts/ValleyDayNight.ts`) runs the valley's day: the sun's path and colour, the moon, the exposure, the morning mist and the god rays, and how bright the fires are. A death skips half a day.
- **Fires** (`examples/scripts/ValleyFireLight.ts`) are linked templates with a tileset flame, embers, sparks that bounce on the floor, and a flickering light. Their flames and embers have an Exposure weight of 0.1, so the camera's exposure barely changes them.
- **The Dungeon** is held at EV 15, the valley's noon, and its fires are lit for that: the souls content (glyphs, glows, bolts) is tuned for an exposure about that. The Time of Day scales the fires down by day and up at night.

- **Leaves let light through** (Material translucency), at the Foliage Creator's values: broad leaves 0.5, grass 0.45, needles 0.25; bark none. The trees' far impostors carry the same glow.
- **Exposure volumes** trim the Day–Night metering by where the camera is. The village gets +0.15 stop, the pond −0.25 and the forest stands +0.35; the forest stands are the 40 m cells with 10 or more trees, merged. Inside each house an Interior trim (+0.5, quicker adaptation) wins at priority 1.
- **The player camera** sits on a 2.4 m arm (1.6 m locked on), sees through trees and the dungeon's pillars, and pulls in for walls and ceilings (`playerCamera` in `build.mjs`).

## Not built

The reference's `valley_outdoor.glb` is not used, so its dungeon façade and tunnel are not either: the skull cave in the cliff notch is the way in.
