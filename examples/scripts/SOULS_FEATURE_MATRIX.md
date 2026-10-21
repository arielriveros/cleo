# Valley — feature matrix

This page lists which engine features the [Valley](SOULS_DEMO.md) example game uses, and which
souls-like game features it has or lacks. It is a map for two jobs:
- **Growing the demo:** what to add next, and whether the engine already supports it.
- **Showcasing the engine:** what the demo does not exercise yet.

| Mark | Meaning |
|---|---|
| ✅ | Used: the demo depends on it. |
| ◐ | Partial: wired up but inert out of the box, or only part of the feature is used. |
| ✗ | Not used. |

"Where" names a generator (`tools/soulsDemo/build.mjs` for the souls content, `tools/valley/` for the level), a
script (`Souls*.ts`), or the scene.

## 1. Engine features

### Rendering

| Feature | Engine piece | | Where / note |
|---|---|---|---|
| WebGL2 and WebGPU backends | `src/graphics/rhi` | ✅ | Runs and was verified on both. |
| Deferred G-buffer pipeline | `Renderer` | ✅ | The default; the blood decals need it. |
| Frustum culling | `Frustum`, BVH | ✅ | Scene config `frustumCulling: true`. |
| Decals (surface and emissive routes) | `DecalNode` | ✅ | Blood splat and spatter decals on hit, plus the bloodstain pool (emissive route). |
| LOD groups / generated LODs | `LodGroupNode` | ◐ | Foliage LOD levels and pine impostors; characters and buildings have none. |
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
| Light probes | `LightProbeNode` | ◐ | One over the pond, for the water's reflection. None in the dungeon. |
| Volumetric clouds | `VolumetricCloudsNode` | ✅ | Wind-driven, with cloud shadows. |

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
| Custom shaders | ✅ | The pond water (`tools/valley/water.glsl`, compiled to WGSL at build time). |
| Cel, Blinn-Phong | ✗ | |
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
| Root motion | ◐ | The roll and the deaths; lunges are scripted (SOULS_DEMO §6). |

### Physics

| Feature | | Where / note |
|---|---|---|
| Static colliders (box, cylinder) | ✅ | About 60 level pieces, each also blocking the camera. |
| Dynamic capsule characters | ✅ | Player and enemies. |
| Raycast | ✅ | Lock-on line of sight, projectile flight, blood decals finding the floor. |
| Ragdoll | ✅ | Humanoid ragdolls on every character's death. |
| Triggers (`onTriggerEnter`/`onTriggerExit`) | ✅ | Every interactable's zone, and the boss arena. Collision callbacks (`onCollision`) are unused. |
| Convex hulls | ✅ | The buildings and the skull cave. |
| Overlap and shape queries (`sweepCapsule`, `sweepSphere`, `overlapSphere`) | ✅ | Blade hitboxes, the bolt, slams (`SoulsHitbox`). |

### Control and AI

| Feature | | Where / note |
|---|---|---|
| Character and player Controller | ✅ | `drive()`, `setMoveWorld`. |
| AI Controller with a behaviour state machine | ✅ | One AI graph asset per enemy type: Idle, Chase, Approach, Strafe, Retreat, Attack, Stagger, Return, Dead (+ Phase Shift on the boss). |
| Perception (field of view, range, memory) | ✅ | Every enemy brain. |
| Blackboard | ✅ | `SoulsEnemyBrain` writes the target; the graph reads senses and builtin enemy fields. |
| Steering | ✅ | |
| NavMesh and pathfinding | ✅ | Baked by the generator with trunks and buildings carved out. |
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
| Spatial audio | ◐ | The barrels' break sound only. |
| Buses, effect rack, `fadeTo` | ✗ | |

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
| Game pause | ✗ | `Game.pause()` / `Game.resume()` exist; nothing calls them. |
| Engine time scale | ✗ (not in engine) | No `timeScale` for scripts. |
| Save / load API | ✗ (not in engine) | |

### Terrain, 2D, publishing

| Feature | | Where / note |
|---|---|---|
| Landscape, foliage, heightmaps | ✅ | A 2 km heightmap landscape with five surfaces, pre-scattered grass, flowers, rocks and pines, wind. |
| Water volumes, buoyancy | ✅ | The pond: wading slows you and stops rolls; barrels and debris float. |
| Multiple scenes, `Game.loadScene` | ✅ | The skull cave loads the Dungeon scene behind a loading overlay. |
| Tilemaps, sprites | ✗ | Not relevant to a 3D souls-like. |
| Publishing (web, desktop) | ◐ | Not exercised by the example itself. Every feature it uses is in player contract 8. |

## 2. Souls-like game features

| Area | Feature | | Evidence / what is missing | Engine support for the missing part |
|---|---|---|---|---|
| Combat | Light combo chain, heavy attack per weapon | ✅ | `SoulsMove` `next` chain, `SoulsWeapon` | |
| | Stamina costs and regeneration delay | ✅ | `SoulsPlayer` | |
| | Roll and backstep with i-frames | ✅ | `SoulsPlayer._computeInvulnerable` → `hurtboxActive` off: blades and bolts pass through | |
| | Sprint (hold roll), input buffering | ✅ | `SoulsPlayer` | |
| | Jump | ✗ | `jumpSpeed: 0` | Ready: `CharacterNode` jump. |
| | Block / guard / shield | ✗ | | Ready: a state plus a stamina-on-block rule in scripts. |
| | Parry and riposte | ✗ | | Ready: animation events for the parry window, `playAction` for the riposte. |
| | Backstab | ✗ | | Ready: the angle test exists (`forwardYaw`, `angleDiff`). |
| | Blade hitboxes | ✅ | `SoulsHitbox.stepSwing`: the blade capsule swept between frames against the hurtbox capsules | Whole-body hurtboxes; no limb multipliers. |
| | Wall bounce | ✅ | `blocksSwings` bodies stop a light swing: sparks, recoil | Heavies plough through. |
| Poise and damage | Enemy poise, stagger, hyper armour | ✅ | `SoulsEnemy.receiveHit` | |
| | Player flinch, heavy stagger with knockback | ✅ | `SoulsPlayer._onDamaged` (via `SoulsCharacter.receiveHit`) | |
| | Player poise | ✗ | SOULS_DEMO §13 | Ready: script only. |
| | Scaling (STR/DEX), requirements, defence | ✅ | `SoulsWeapon.attackRating`, `SoulsCharacter.applyDefense` | |
| Progression | Souls and level-up (Vigor, Endurance, Strength, Dexterity) | ✅ | `SoulsBonfireMenu` | |
| | Bloodstain recovery | ✅ | `SoulsGameManager.dropBloodstain` | |
| Items | Estus flask, Estus Shard | ✅ | `SoulsPlayer`, `SoulsPickup` | |
| | Two-weapon swap | ✅ | `SoulsCharacter.equipWeapon` | Weapons are templates (variants of `Weapon`), spawned by name from `weaponTemplates`. |
| | Enemies drop their weapon on death (physics body until the corpse goes) | ✅ | `SoulsCharacter.dropWeapon` | |
| | Inventory / equipment menu, armour, rings, consumables | ✗ | | Ready: UI widgets plus scripts. Images would help (`uiImage`). |
| | Keys and keyed doors | ✗ | | Ready: `SoulsDoor` plus a pickup `kind`. |
| Enemies | Melee, ranged caster, elite with hyper armour | ✅ | 4 enemy templates | |
| | Spacing, strafing, leash and return, attack weights, cooldowns | ✅ | AI graphs (decisions), `SoulsEnemy` (attack choice, movement) | |
| | Respawn on rest | ✅ | `SoulsEnemySpawn` | |
| | Pathfinding around obstacles | ✅ | Baked navmesh | |
| Boss | Fog gate, boss bar, two phases (roar, speed-up, new attacks), reset on death, reward | ◐ | `SoulsFogGate`, `SoulsEnemy._startPhase2` ship as templates, but no boss is placed in the valley or the dungeon | Ready: place the Hollow Warden and a Fog Gate. |
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
| | Pause menu | ✗ | The `Pause` action exists but nothing reads it | Ready: `Game.pause()` plus a UI canvas. |
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

1. **A boss.** The Warden, its fog gate and boss bar are finished templates; the dungeon is the obvious arena.
2. **Pause menu and settings.** Small cost: `Game.pause()`, UI widgets, and disabling the Gameplay map.
3. **Save and load.** High value, medium cost. Needs an **engine save API** (key/value storage that works
   in web and desktop builds). Then a script persists souls, stats, shortcuts and boss state.
4. **Guard, parry, riposte and backstab.** The defining combat verbs, script-only. Parry windows ride on
   the existing animation events.
5. **Hit-stop.** Cheap and very noticeable, but needs an **engine time scale** first (global, or per
   animator plus physics).
6. **Keys and keyed doors.** Trivial with `SoulsDoor` and a new pickup `kind`.
7. **Assign audio samples.** No code: every sound slot is wired and empty.
8. **Per-bone hurtboxes.** Head and limb hits, with multipliers. The shape queries already support it;
   it needs small capsules that follow the skeleton.
9. **Ladders and NPCs.** Larger script work: a climb state, a dialogue UI.

The engine features the game does not exercise yet, and that could be shown with little change:
- light probes in the dungeon, spot lights with shadows on its torches;
- height fog and god rays on the sky;
- foot IK on the characters (the valley is all slopes);
- LODs on the buildings and characters;
- buses, an effect rack (cave reverb) and music crossfades with `fadeTo`.
