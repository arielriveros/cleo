# Hollow Keep — feature matrix

This page lists which engine features the [Hollow Keep](SOULS_DEMO.md) example uses, and which
souls-like game features it has or lacks. It is a map for two jobs:
- **Growing the demo:** what to add next, and whether the engine already supports it.
- **Showcasing the engine:** what the demo does not exercise yet.

| Mark | Meaning |
|---|---|
| ✅ | Used: the demo depends on it. |
| ◐ | Partial: wired up but inert out of the box, or only part of the feature is used. |
| ✗ | Not used. |

"Where" names the generator (`tools/soulsDemo/build.mjs`), a script (`Souls*.ts`), or the scene.

## 1. Engine features

### Rendering

| Feature | Engine piece | | Where / note |
|---|---|---|---|
| WebGL2 and WebGPU backends | `src/graphics/rhi` | ✅ | Runs and was verified on both. |
| Deferred G-buffer pipeline | `Renderer` | ✅ | The default; the blood decals need it. |
| Frustum culling | `Frustum`, BVH | ✅ | Scene config `frustumCulling: true`. |
| Decals (surface and emissive routes) | `DecalNode` | ✅ | Blood splat and spatter decals on hit, plus the bloodstain pool (emissive route). |
| LOD groups / generated LODs | `LodGroupNode` | ✗ | Placeholder geometry is too cheap to need them. |
| Quality presets, render scale | `RenderSettings` | ✗ | Defaults only. |
| Performance HUD, profilers | `renderStats`, `gpuProfiler` | ◐ | Editor tooling. Used to measure the demo, not by it. |

### Lighting and environment

| Feature | Engine piece | | Where / note |
|---|---|---|---|
| Directional sun with cascaded shadows | `LightNode` | ✅ | A 28,000 lux dusk sun. |
| Point lights | `LightNode` | ✅ | 28 of them (torches, pickups, bonfire, bolts). None cast shadows. |
| Spot lights, point and spot shadows | `LightNode` | ✗ | |
| Lights driven by scripts | `light.intensity` | ✅ | The bonfire lights up (`SoulsBonfire`), and effects fade their lights (`SoulsFx`). |
| Physical sky | `SkyAtmosphereNode` | ✅ | Its height fog and god rays are turned **off**. |
| Skybox, sky light (SH ambient) | `SkyboxNode`, `SkyLightNode` | ✗ | Scene `ambientLight` is used instead. |
| Light probes | `LightProbeNode` | ✗ | |
| Volumetric clouds | `VolumetricCloudsNode` | ✗ | The level is mostly enclosed. |

### Post-processing

| Feature | | Where / note |
|---|---|---|
| Manual exposure | ✅ | 1.1, auto-exposure off. |
| Tone mapping (AgX) | ✅ | The engine default. |
| Bloom | ✅ | Torches, glyphs, bolts. |
| SSAO | ✅ | |
| TAA | ✅ | The engine default. |
| Vignette, saturation | ✅ | 0.35 and 0.78. |
| Motion blur | ✗ | Explicitly turned off. |
| Depth of field, lens flare and dirt, grain, chromatic aberration, LUT grading | ✗ | |
| Screen-space custom materials | ✗ | |

### Materials

| Feature | | Where / note |
|---|---|---|
| PBR | ✅ | All 21 materials, including the textured blood decal materials. |
| Emissive | ✅ | Glyphs, items, bolt, bonfire ash, bloodstain. |
| Transparency | ✅ | The fog wall. |
| Cel, Blinn-Phong, Custom shaders | ✗ | |
| Height, parallax, displacement | ✗ | |
| Procedurally generated textures | ✅ | The blood splat images (`tools/soulsDemo/png.mjs`). |

### Animation

| Feature | | Where / note |
|---|---|---|
| Skinned models with an animator | ✅ | The mannequin on every character. |
| State machine with built-in parameters | ✅ | Three states, `planarSpeed`/`planarAngle`, and the `Died`/`Revive` triggers. |
| 2D blend space (`.afield`) | ✅ | "Souls Locomotion", with a sprint sample. |
| Action slots (`playAction`) | ✅ | Every attack, roll, drink and reaction. |
| Clip events (`onAnimationEvent`) | ✅ | Hit, combo, recover, drink and cast timing. |
| Bone sockets | ✅ | Weapons via `socketAttachment`; bolt origin via `getSocketWorldMatrix`. |
| Rig asset, retargeting | ✅ | One shared rig. |
| Layers, bone masks, Pose assets, Animation Controller asset | ✗ | |
| Foot IK | ✗ | |
| Root motion | ✗ | Off by design: lunges are scripted (SOULS_DEMO §6). |

### Physics

| Feature | | Where / note |
|---|---|---|
| Static colliders (box, cylinder) | ✅ | About 60 level pieces, each also blocking the camera. |
| Dynamic capsule characters | ✅ | Player and enemies. |
| Raycast | ✅ | Lock-on line of sight, projectile flight, blood decals finding the floor. |
| Ragdoll | ◐ | Enemies on death; the player does not ragdoll. |
| Triggers (`onTrigger`), collision callbacks (`onCollision`) | ✗ | Interactables use distance checks instead. |
| Convex hulls | ✗ | |
| Overlap and shape queries | ✗ (not in engine) | Melee uses a range-plus-arc check (§2). |

### Control and AI

| Feature | | Where / note |
|---|---|---|
| Character and player Controller | ✅ | `drive()`, `setMoveWorld`. |
| AI Controller with a behaviour state machine | ✅ | Idle, Chase, Engage, Return, Dead, driven by blackboard flags. |
| Perception (field of view, range, memory) | ✅ | Every enemy brain. |
| Blackboard | ✅ | `SoulsEnemyBrain` writes the flags. |
| Steering | ✅ | |
| NavMesh and pathfinding | ◐ | A `Nav Mesh` node exists but ships **unbaked**, so chases fall back to straight lines until you bake it. |
| AI Brain assets, goal planner, fuzzy logic, flocking | ✗ | The behaviour machine is inline on each brain. |

### Particles and VFX

| Feature | | Where / note |
|---|---|---|
| GPU particle systems (`.vfx`) | ✅ | 12 systems: fires, fog wall, bolt, impacts, sparks, dust, glows, aura, blood spray. |
| Modules: rate, burst, shapes, curl noise, drag, gravity, over-life curves, velocity stretch, lit, soft | ✅ | |
| Script control: `play`, `stop`, `burst` | ✅ | |
| Sub-emitters, depth collision, force fields, custom WGSL | ✗ | |

### Audio

| Feature | | Where / note |
|---|---|---|
| Sound nodes, `play`/`stop` from scripts | ◐ | 27 SFX and 2 music cues are wired, but every sample slot is **empty**, so it is silent until you assign files. |
| Spatial audio, buses, effect rack, `fadeTo` | ✗ | |

### UI

| Feature | | Where / note |
|---|---|---|
| Screen canvases | ✅ | HUD, banners, bonfire menu. |
| World canvases (billboarded) | ✅ | Enemy health bars, lock reticle. |
| Progress bars, text, panels, buttons (`onPress`) | ✅ | |
| Images, sliders, toggles, text input, touch controls | ✗ | |

### Input

| Feature | | Where / note |
|---|---|---|
| Action maps (button and vector actions) | ✅ | A Gameplay map with 12 actions, plus a UI map. Shipped as `inputMap.json`. |
| Gamepad and keyboard/mouse; deadzone and scale processors; pointer lock | ✅ | |
| Enabling and disabling maps | ✅ | The bonfire menu. |
| Press-to-rebind | ✗ | |

### Scripting, scenes and assets

| Feature | | Where / note |
|---|---|---|
| Class scripts with inspector-reflected fields | ✅ | 23 scripts. |
| Script modules | ✅ | `SoulsMath`. |
| Timers (`after`), `scene.instantiate`, `remove` | ✅ | Spawns, effects, bloodstains, blood decals. |
| Templates as linked copies with overrides | ✅ | Player, torches, messages, pickups, bonfire, lever, gate, fog gate. |
| Runtime spawning from templates | ✅ | Enemies, effects, projectiles. |
| Spawn/despawn lifecycle (`spawnOnStart`) | ✗ | |
| Event bus | ✗ | The GameManager is the hub instead (SOULS_DEMO §4). |
| Engine time scale, game pause | ✗ (not in engine) | No `timeScale` or pause API for scripts (§2). |
| Save / load API | ✗ (not in engine) | |

### Terrain, 2D, publishing

| Feature | | Where / note |
|---|---|---|
| Landscape, foliage, heightmaps | ✗ | The level is blockout geometry. |
| Tilemaps, sprites | ✗ | Not relevant to a 3D souls-like. |
| Publishing (web, desktop) | ◐ | Not exercised by the example itself. Every feature it uses is in player contract 8. |

## 2. Souls-like game features

| Area | Feature | | Evidence / what is missing | Engine support for the missing part |
|---|---|---|---|---|
| Combat | Light combo chain, heavy attack per weapon | ✅ | `SoulsMove` `next` chain, `SoulsWeapon` | |
| | Stamina costs and regeneration delay | ✅ | `SoulsPlayer` | |
| | Roll and backstep with i-frames | ✅ | `SoulsPlayer._computeInvulnerable` | |
| | Sprint (hold roll), input buffering | ✅ | `SoulsPlayer` | |
| | Jump | ✗ | `jumpSpeed: 0` | Ready: `CharacterNode` jump. |
| | Block / guard / shield | ✗ | | Ready: a state plus a stamina-on-block rule in scripts. |
| | Parry and riposte | ✗ | | Ready: animation events for the parry window, `playAction` for the riposte. |
| | Backstab | ✗ | | Ready: the angle test exists (`forwardYaw`, `angleDiff`). |
| | Blade hitboxes (instead of range plus arc) | ✗ | Hits are range and arc checks | **Engine gap:** no overlap or shape queries (`onTrigger` only fires on physics steps). |
| Poise and damage | Enemy poise, stagger, hyper armour | ✅ | `SoulsEnemy.receiveHit` | |
| | Player flinch, heavy stagger with knockback | ✅ | `SoulsPlayer.receiveDamage` | |
| | Player poise | ✗ | SOULS_DEMO §13 | Ready: script only. |
| | Scaling (STR/DEX), requirements, defence | ✅ | `SoulsGameManager.attackRating` | |
| Progression | Souls and level-up (Vigor, Endurance, Strength, Dexterity) | ✅ | `SoulsBonfireMenu` | |
| | Bloodstain recovery | ✅ | `SoulsGameManager.dropBloodstain` | |
| Items | Estus flask, Estus Shard | ✅ | `SoulsPlayer`, `SoulsPickup` | |
| | Two-weapon swap | ✅ | | |
| | Inventory / equipment menu, armour, rings, consumables | ✗ | | Ready: UI widgets plus scripts. Images would help (`uiImage`). |
| | Keys and keyed doors | ✗ | | Ready: `SoulsDoor` plus a pickup `kind`. |
| Enemies | Melee, ranged caster, elite with hyper armour | ✅ | 4 enemy templates | |
| | Spacing, strafing, leash and return, attack weights, cooldowns | ✅ | `SoulsEnemy`, `SoulsEnemyBrain` | |
| | Respawn on rest | ✅ | `SoulsEnemySpawn` | |
| | Pathfinding around obstacles | ◐ | Navmesh unbaked | Ready: bake it in the editor (SOULS_DEMO §11.11). |
| Boss | Fog gate, boss bar, two phases (roar, speed-up, new attacks), reset on death, reward | ✅ | `SoulsFogGate`, `SoulsEnemy._startPhase2` | |
| World | Bonfire checkpoint, rest, respawn point | ✅ | `SoulsBonfire` | |
| | Lever shortcut, one-way gate | ✅ | `SoulsLever`, `SoulsDoor` | |
| | Readable messages | ◐ | Authored only: players cannot write or rate them. | |
| | NPCs and dialogue | ✗ | | Ready: UI plus interactables. |
| | Traps, ladders, elevators | ✗ | | Ready for traps and elevators (`onTrigger`, kinematic bodies). Ladders need a climb state. |
| | Kill plane | ✅ | `SoulsPlayer.killY` | |
| Camera | Lock-on with switching, line of sight, reticle, auto-retarget | ✅ | `SoulsLockOn` | |
| | Camera collision | ✅ | Camera-collision colliders | |
| UI and menus | HUD (HP with drain bar, stamina, Estus, souls, prompts, messages) | ✅ | `SoulsHud` | |
| | Banners: YOU DIED, BONFIRE LIT, VICTORY | ✅ | `SoulsBanner` | |
| | Floating enemy health bars | ✅ | World canvases | |
| | Pause menu | ✗ | The `Pause` action exists but nothing reads it | **Engine gap:** no game-pause API for scripts. A menu can still disable the Gameplay map and freeze the GameManager. |
| | Settings and title screen | ✗ | | Ready: UI widgets. Rebinding exists in the engine. |
| Audio | SFX cues, ambience and boss music switching | ◐ | Wired, but the samples are empty | Ready: assign samples. Spatial mode, buses and `fadeTo` are unused. |
| Feedback | Screen shake | ✅ | `GameManager.shake` | |
| | Hit sparks, slam dust, enemy ragdoll | ✅ | | |
| | **Blood:** spray, splat and spatter decals | ✅ | `GameManager.bleed`, `SoulsBloodSplat` | |
| | Hit-stop (freeze frames) | ✗ | | **Engine gap:** no time scale. It would need an engine `timeScale` (or per-animator speed). |
| | Controller rumble | ✗ | | **Engine gap:** no haptics API. |
| Persistence | Save and load (souls, level, opened shortcuts, defeated boss) | ✗ | Everything resets on reload | **Engine gap:** no save API. Scripts would have to use `localStorage` directly, which is unavailable in desktop builds without a bridge. |

## 3. Gaps worth filling next

Ranked by what they add against what they cost.

1. **Pause menu and settings.** High value, small cost: UI widgets plus disabling the Gameplay map.
   A real pause needs an **engine game-pause API**; until then a "soft pause" can freeze the GameManager
   and the enemy brains.
2. **Save and load.** High value, medium cost. Needs an **engine save API** (key/value storage that works
   in web and desktop builds). Then a script persists souls, stats, shortcuts and boss state.
3. **Guard, parry, riposte and backstab.** The defining combat verbs, script-only. Parry windows ride on
   the existing animation events.
4. **Hit-stop.** Cheap and very noticeable, but needs an **engine time scale** first (global, or per
   animator plus physics).
5. **Keys and keyed doors.** Trivial with `SoulsDoor` and a new pickup `kind`.
6. **Bake the navmesh, assign audio samples.** No code: these make two wired features actually work.
7. **Blade hitboxes.** Better melee accuracy. Needs **engine overlap queries** (sphere/capsule casts),
   or per-step triggers.
8. **Ladders and NPCs.** Larger script work: a climb state, a dialogue UI.

The engine features the demo does not exercise yet, and that could be shown with little change:
- light probes in the interiors;
- height fog and god rays on the sky (turned off for clarity today);
- spatial audio;
- foot IK on the characters;
- LODs on final art;
- a landscape outside the walls.
