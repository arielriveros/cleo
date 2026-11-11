# Valley example generator

Builds two examples:

- `applications/editor/public/examples/valley/`, the **Valley**: an outdoor mountain valley with a day and night cycle, as scenery. Play flies a free camera (`examples/scripts/ValleyFlyCamera.ts`, on the input map in `flyInputMap.mjs`).
- `applications/editor/public/examples/dungeon/`, the **Dungeon**: the souls content of `tools/soulsDemo/build.mjs` in a three-level dungeon, the engine's example game.

`build.mjs` writes them as one project with two scenes, the souls game on both and the skull cave in the cliff notch the door between them, as it always has; then `split.ts` makes that two projects. It takes the Valley's gameplay out (the player, enemies, nav mesh, Game Manager, barrels, messages, pickups, lever and gate, the skull cave with its probe, GI volume, mist and torches, the pond's wading zone; the bonfire becomes a plain campfire), puts the fly camera in, removes the Dungeon's way back up, and keeps in each project only the assets it reaches. `split.ts` also runs on its own over the two shipped folders: it edits the shipped data, and running it again refreshes the Valley scripts from `examples/scripts`.

```sh
python tools/valley/prepare.py                          # unzips new downloads; textures: build/ -> build/valley_prepared/
node --max-old-space-size=12288 tools/valley/build.mjs  # writes both examples (build, then split.ts)
node tools/valley/bakeGI.cjs                            # captures the Valley's GI volumes into it (Chrome, WebGPU; a few minutes)
node tools/valley/bakeGI.cjs --example dungeon          # the Dungeon's
npm --prefix applications/editor run examples:list      # refreshes the gallery index
npx vitest run tests/valleyProject.test.ts tests/dungeonProject.test.ts tests/dungeonSouls.test.ts tests/dungeonCollision.test.ts

# without build/: re-apply the split to the shipped examples (after editing a Valley script, say)
NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/valley/split.ts
```

The source art in `build/` is gitignored, so this generator is run by hand and its output is committed.

## Inputs (`build/`)

| File | Becomes |
|---|---|
| `valley_height_4097_16bit.png` | The landscape. It covers the whole 2048 m map; every second sample is kept, giving a 2049² grid at 1 m spacing. |
| `terrain_textures/brown_mud_leaves_01_1k` | Ground, the base surface. |
| `terrain_textures/rock_05_1k` | Rock slot: slopes of 36° and steeper. `prepare.py` lifts its roughness to weathered rock's (about 0.79, `ROCK_ROUGHNESS`). |
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
| `props/skull_cave` | The Skull Cave Entrance in the cliff notch, the door between the two scenes until `split.ts` takes it out. |
| `props/medieval_dungeon_structure (1).glb` | The Dungeon, at full detail: split into 10 m chunks, its lights read as placement anchors. |
| `wall_textures` | The dungeon's stone: walls, slabs, brick and cobbled floors. Wood and metal keep the structure's own textures. |
| `props/wall_torch_model`, `props/medieval_torch.glb` | Wall-mounted and standing torches. |
| `props/campfire_fire_with_stones.glb`, `props/dungeon_cage.glb`, `props/bookcase.glb`, `props/weapons` | The bonfire and fire pits, cages and braziers, bookcases, racked and dropped weapons. |
| `medieval_knight__sculpture__game_ready.glb` | The player: a Mixamo-rigged knight (shield left out) on its own `Knight` rig, playing the mannequin's clips, animators and blend spaces through a retarget (`knight.mjs`). |

## Files

- `layout.mjs` holds every position from the map's technical reference: spawn, pads, roads, gate plaza and sun. Heights are always sampled, never stored here.
- `heights.mjs` decodes the PNG with the engine's `heightmapIO.ts`.
- `landscape.mjs` builds the landscape material, the painted masks (seven channels in two slices: trail, forest floor, dirt road, stone path, clay, sand, dirt), and the CPU surface weights. The weights come from the engine's `terrainLayers.ts`, so the pre-baked foliage respects the same rules the shader draws. Every surface (Ground, Dirt, Rocky Dirt, Forest Floor, Rock, Snow, Pond Clay, Shore Sand, Trail, Stone Path) is also a library material under `/Environment/Landscape/Materials`, linked from its slot (`LANDSCAPE_SURFACES`).
- `creatorFoliage.mjs` lists the plants and generates them with the Foliage Creator (`genFoliage.ts`, through `vite-node`); `build.mjs` turns each one's levels, materials and impostor into a library model, library materials and a foliage rule.
- `creatorFx.mjs` lists the effects (the two flames, their smoke, the blood, the splashes) and bakes them with the FX Creator (`genFx.ts`, through `vite-node`, its CPU solvers), cached in `build/valley_creator/fx-*`; `build.mjs` makes the flames' and the smoke's tilesets (the smoke's with its six-way lightmaps), the blood splatter's (with its surface maps), the splash particle systems, the puddles, and the blood decals' materials and templates from them. A first build bakes for about a quarter of an hour (the flames are most of it).
- `foliage.mjs` holds the library-asset helpers, the dungeon's moss rocks and the seeded scatter. Placement is pre-baked because opening a scene never scatters.
- `props.mjs` handles the FBX props: assimp to parts, with scaling. Some files carry no unit stamp, so those props are sized to a stated height. It also measures the windmill hub.
- `water.glsl` / `water.mjs` hold the pond's water: a transparent forward custom material (waves from a generated tiling normal map, Fresnel reflection of the pond's light probe, a sun glint, refraction with depth absorption, shore foam and a soft edge) and its uniforms. `compileCustomWgsl.ts` translates it to WGSL at build time (through `vite-node`), so a published WebGPU game can render it.
- `presets.ts` resolves the engine presets the valley's look is made of, through `vite-node`: the Sunny 16
  fixed exposure, the Cinematic lens look and depth of field, the Hazy Summer sky, Sunny clouds, a Breezy wind,
  a Pond / Lake water volume and the Morning Sun (brightened against the valley's ambient). The High quality tier
  and a sky light with cloud shadows complete it. Nothing in the look is hand-tuned; change a preset to change it.
- `houses.mjs` makes the Old House and the Long House enterable. It rasterises each into wall and lintel boxes, merged the way the dungeon's are, under one convex hull for the roof, with the doorways left open; the build logs each house's lowest lintel over its floor. Both stand on a raised floor, so the ground inside is raised to it and eased back to the hillside outside, and the navmesh carves only round the walls.
- `meshes.mjs` contains the part pipeline. It flips glTF V, leaves tangents for `Geometry` to rebuild, rounds values for JSON, and builds convex hulls.
- `torches.mjs` builds the fire props (wall and standing torches, campfire, cages, candles) and finds walls to hang torches on.
- `dungeon/` builds the Dungeon: `structure.mjs` loads and chunks the structure and opens its sealed doorways; `collision.mjs` rasterises its floors, walls, ceilings and stairs into box colliders (the scene format has no triangle meshes), keeping their number down (cells merged within a tolerance, a pillar one box, a diagonal wall one turned box), and checks the level can be walked; the pillars' boxes go on bodies of their own that the camera sees through; `layout.mjs` holds the zones, fires, enemies, pickups and messages; `props.mjs` the procedural furniture; `scene.mjs` assembles it.
- `knight.mjs` builds the player character: the skinned GLB read headlessly (`tools/exampleKit/skinnedGlb.mjs`), scaled to 1.9 m, one model with a submesh per material, its rig with hand sockets that turn its hand frame into the mannequin's (so the same weapons sit in either fist), and foot IK.
- `build.mjs` assembles everything around `writeProject` from `tools/soulsDemo/build.mjs`, then runs `split.ts`.
- `split.ts` (through `vite-node`) splits the project in two and prunes each half with the editor's own asset reference edges (`assetEdges.ts`), plus the names scripts and node fields give (a template spawned by name). The Dungeon keeps the whole souls kit, which its scripts reach by name.

## Light and time

- **The Time of Day** node (`examples/scripts/ValleyDayNight.ts`) runs the valley's day: the sun's path and colour, the moon, the exposure, the morning mist and the god rays, and how bright the fires are.
- **Fires** (`examples/scripts/ValleyFireLight.ts`) are linked templates with a flame, embers, sparks that bounce on the floor, and a flickering light. The flames are FX Creator flipbooks: Torch Fire (tall 128 x 256 frames) on the torches, braziers and candles, Bonfire Fire (a 2.7 s loop) on the bonfire, fire pits and hearth. Lighting a bonfire plays Bonfire Ignition once, a flare that settles into the loop as the light swells and the smoke thickens.
- **GI volumes.** Probe grids light the hamlet and each house interior with the light bounced off what is round them (`giVolumes()` in `build.mjs`): 5.5 m apart over the hamlet, a metre apart inside, where the box is the interior exposure volume's grown 0.3 m past the walls. They relight themselves as the sun turns. Their captures are baked by `bakeGI.cjs`: the editor on a private dev server (8092) in the installed Chrome over the DevTools protocol (9336), the Valley imported, each volume captured afresh and saved into the example's assets under its `bakeId`. `build.mjs` carries the bakes over from one build to the next (the volumes keep their ids); a bake whose geometry has since moved is caught when it loads, and that volume captures again. `bakeGI.cjs --only "Hamlet GI"` re-bakes one.
- **Light probes.** The Valley Probe (unbounded, reflections only) is the fallback everywhere. Local probes reflect their own surroundings: the Bonfire, the Hamlet, the Pond (the water reflects it) and the Windmill. Each house interior is lit and reflected by its own probe, box-projected, its box the interior exposure volume's; its lighting and reflections hold from outside the door too. Every capture is shadowed by the sun, and the Time of Day relights them every 4 degrees of sun (the captured scene lit again, a few frames per probe, no geometry redrawn).
- **Smoke** rises off the Valley's campfire and the Dungeon's bonfire and fire pits: the Creator's smoke plume on a lit sprite, relit by its six-way lightmaps (the sun and its shadows, the fire below).
- **Blood and splashes** are FX Creator liquids too: a hit's blood is a lit Blood Burst splatter at the contact point and the Blood Spatter decal (three quarters of the bake's size) as the blood lands, no particles; the Blood Pool decal is the bloodstain where the player last died. The pond throws a Water Splash crown where something enters it (a floating crate dropped in, say) and a small Water Step at a wading character's feet, both played by `examples/scripts/ValleyFx.ts`.
- **The Dungeon** is held at EV 15, the valley's noon, and its fires are lit for that: the souls content (glyphs, glows, bolts) is tuned for an exposure about that.

- **Leaves let light through** (Material translucency), at the Foliage Creator's values: broad leaves 0.5, grass 0.45, needles 0.25; bark none. The trees' far impostors carry the same glow.
- **Exposure volumes** trim the Day–Night metering by where the camera is. The village gets +0.15 stop, the pond −0.25 and the forest stands +0.35; the forest stands are the 40 m cells with 10 or more trees, merged. Inside each house an Interior trim (+0.5, quicker adaptation) wins at priority 1.
- **The player camera** (the Dungeon's) sits on a 2.4 m arm (1.6 m locked on), sees through the dungeon's pillars, and pulls in for walls and ceilings (`playerCamera` in `build.mjs`).
- **The fly camera** (the Valley's) starts 2.5 m over the old player spawn, facing up the valley, and never goes below the landscape; its depth of field is off.

## Not built

The reference's `valley_outdoor.glb` is not used, so its dungeon façade and tunnel are not either: the skull cave in the cliff notch is the way in.
