# Reference — node types

Every node class, the `nodeType` string it serializes as, and its own API. The base `Node` API that
all of them inherit is documented in [Node API](../scripting/node-api.md) and is not repeated here.

The `nodeType` strings are persisted in saved scenes. Adding one is safe; renaming one breaks
existing saves — which is why some names look dated.

```ts
type NodeType =
  | 'node' | 'model' | 'light' | 'lightProbe' | 'skybox' | 'camera' | 'sprite' | 'animatedSprite'
  | 'landscape' | 'tilemap' | 'volumetricClouds' | 'skyAtmosphere' | 'skyLight' | 'wind' | 'weather' | 'lodGroup'
  | 'cameraRig' | 'sound' | 'character' | 'controller' | 'navMesh' | 'decal'
  | 'particleSystem' | 'forceField' | 'waterVolume' | 'occlusionVolume' | 'exposureVolume' | 'volumetricFog'
  | 'fluidVolume' | 'cloth' | 'giVolume' | 'sequence'
  | 'camera2D' | 'room2D' | 'parallaxLayer' | 'characterBody2D' | 'body2D' | 'area2D'
  | 'uiRoot' | 'uiPanel' | 'uiText' | 'uiImage' | 'uiButton' | 'uiStack' | 'uiSpacer'
  | 'uiProgressBar' | 'uiSlider' | 'uiToggle' | 'uiTextInput';
```

`isUINodeType(type: string): boolean` tells you whether a type belongs to the UI family — the
eleven types whose layout is resolved by the scene's UI pass.

---

## Node — `'node'`

The base class, shown as **Empty** in the editor. A transform, children, optionally a body, a
trigger, variables and a script. Everything else on this page extends it.

Full API: [Node API](../scripting/node-api.md), [Lifecycle](../scripting/lifecycle.md),
[Motion and physics](../scripting/motion-and-physics.md).

---

## Geometry and models

### ModelNode — `'model'`

A drawable mesh. Created by importing a model, or by adding a primitive from the Add catalog.

```ts
get model: Model | AnimatedModel
get animator: Animator | null          // present for a skinned model
get initialized: boolean
initializeModel(): void
dispose(): void
get/set ragdollConfig: RagdollOptions | null
get/set movementDirection: vec3
get boundsMargin: number
```

Overrides `getBoundingBox()`, `getBoundingSphere()` and `getBVH()`. A skinned mesh inflates its
bounds by **1.75×** (an animated pose leaves the bind-pose box) and returns `null` from `getBVH()` —
you cannot raycast a skinned mesh per-triangle.

Its `update()` drives the animator, unless `scene.animationsEnabled === false`.

The free function `disposeModelSubtree(root)` releases GPU meshes for a whole branch.

### LodGroupNode — `'lodGroup'`

Wraps several detail levels of the same model. Created automatically when you place a model asset
that has LOD levels.

```ts
distances: number[] = [0]     // takeover distance per level
cullDistance: number = 0      // 0 = never culled
get activeLod: number
get distanceCulled: boolean
updateLod(camPos: vec3): void
```

> LOD switching uses an internal `_lodVisible` flag, **not** the `visible` property. A script that
> sets `visible` on a LOD child fights the LOD system.

---

## Cameras

### CameraNode — `'camera'`

```ts
get camera: Camera
get/set active: boolean
get/set postChain: readonly PostChainEntry[] | null    // per-camera post-processing
get/set screenMaterials: CustomMaterial[]
get/set focusTarget: Node | null
focusTargetId: string | null                            // depth of field focuses on this node
```

The camera looks down its own **+Z**.

### CameraRigNode — `'cameraRig'`

A spring arm: it sits above a `CameraNode` child and **overwrites that child's local position and
rotation every frame**. Driven by the scene's late pass, after every `onUpdate`, so a rig-driven
camera never trails its target.

```ts
get/set follow: Node | null ;  followId: string | null
get/set lookAt: Node | null ;  lookAtId: string | null
get/set yaw: number     // a WORLD yaw — the rig cancels its parent's rotation each frame
get/set pitch: number
addYaw(raw: number): void ; addPitch(raw: number): void
setOrbit(yaw: number, pitch: number): void
shake(amount: number): void ; stopShake(): void ; get trauma: number
snapToTarget(): void
get camera: CameraNode | null
get pivotPosition: vec3 ; get currentArmLength: number
```

Fields: `followOffset`, `followSpace` (`'world' | 'targetYaw' | 'targetFull'`), `followDamping`,
`followDampingSpace`, `aimMode` (`'orbit' | 'lookAt' | 'none'`), `lookAtOffset`, `aimDamping`,
`yawSensitivity`, `pitchSensitivity`, `invertPitch`, `yawMin` / `yawMax`, `pitchMin = -80` /
`pitchMax = 80`, `armLength = 4`, `socketOffset`, `fovEnabled` / `fov` / `fovDamping`,
`collisionEnabled` / `collisionRadius` / `collisionMinRatio` / `collisionPullTime` /
`collisionReturnTime` / `collisionIgnoreIds`, `collisionMode` (`'retract' | 'dither'`) /
`ditherRadius = 1` / `ditherStrength = 0.85`, `shakePositionAmplitude`, `shakeRotationAmplitude`,
`shakeFrequency`, `shakeDecay`, `shakeSustained`, `cameraNodeId`.

> Put a shoulder offset on **`socketOffset`**, never on the Camera child — the rig rewrites the
> child's whole local position every frame and would overwrite it.
>
> Because the rig publishes a *world* yaw and cancels its parent's rotation, the camera is not
> dragged around when the body underneath it turns. This is why a third-person pivot must be a
> Camera Rig and not a plain Empty.

---

## Gameplay

### CharacterNode — `'character'` *(unreleased)*

A pawn: it turns a control intent into velocity and facing. It does not read input — a
[Controller](#controllernode--controller-unreleased) possesses it and writes the intent.

**Animator outputs** (plain fields, deliberately not getters — the animator's variable binding uses
`hasOwnProperty`, which a prototype getter fails):

| Field | Meaning |
|---|---|
| `moveDir: number` | Strafe angle in degrees relative to facing. `0` ahead, **`-90` right**, **`+90` left**, `±180` back. |
| `isJumping: boolean` | True from take-off until the feet land. |
| `turnRequest: number` | Turn-in-place clip selector: `0` none, `±1` 90°, `±2` 180°. **Opposite sign to `moveDir`** — it is a selector, not an angle. |

**Tuning:** `walkSpeed = 1.5`, `runSpeed = 4`, `jumpSpeed = 4`, `turnSpeed = 540`,
`turnThreshold = 90`, `turnReleaseAngle = 10`, `directionSmoothing = 0.12`, `acceleration = 0`,
`airControl = 1`, `coyoteSeconds = 0.12`, `jumpBufferSeconds = 0.15`, `jumpLockoutSeconds = 0.15`,
`facingMode` (`'aim' | 'velocity' | 'none'`), `driveWhenUnpossessed = false`.

```ts
get intent: Readonly<ControlIntent>
drive(): ControlIntent          // mutable intent; marks it fresh this frame
get controller: ControllerNode | null
get isControlled: boolean
get tuning: LocomotionTuning
get locomotionState: LocomotionState
```

> **Never write `this.velocity` from a script on a Character.** Locomotion writes it every frame; a
> second writer produces a character that stutters. Influence it through the inspector or the
> intent — `this.drive().speedScale = 0.5`.

### ControllerNode — `'controller'` *(unreleased)*

The driver. It possesses a Character and writes its intent in the scene's control pass, before any
`onUpdate`. Full API and semantics: [AI (scripting)](../scripting/ai.md).

```ts
possess(node: CharacterNode | null): this   // last-possess-wins, warns when stealing
release(): this
think(delta: number): void                  // called by the scene, not by you
perceive(delta: number): void
getBlackboard(key: string): BlackboardValue | undefined
setBlackboard(key: string, value: BlackboardValue | undefined): void   // undefined deletes
clearBlackboard(): void
fuzzyValue(name: string): number
```

Key properties: `controlSource` (`'player' | 'ai' | 'none'`), the action names
`moveAction = 'Move'` / `lookAction = 'Look'` / `jumpAction = 'Jump'` / `sprintAction = 'Sprint'` /
`crouchAction = ''`, `aimSource` (`'possessed' | 'node' | 'world'`), `driveAimTarget = true`,
`goal` (an `AiGoal`), `targetKey = 'target'`, `goalPoint`, `behavior`, `goals`, `fuzzy`,
`brain` (`'machine' | 'goal' | 'none'`), `brainId`, `perception`, `eyeHeight = 1.6`,
`autoAcquire = true`, `steering`, `whiskerCount = 3`, `whiskerSpread = 60`, `flockRadius = 6`,
`separationWeight = 1.5`, `alignmentWeight = 1`, `cohesionWeight = 0.8`, `navMeshId`,
`routeName`, `repath`, `waypointRadius = 0.5`.

Read-only: `possessed`, `path`, `pathRemaining`, `aimRig`, `sightings`, `lastKnownPosition`,
`blackboardKeys`, `goalTarget`, `behaviorState`, `goalState`, `goalPlan`, `neighborCount`.

> `pathRemaining` and `neighborCount` **compute on read**. Do not call them in a tight loop.

### NavMeshNode — `'navMesh'` *(unreleased)*

A baked navigation mesh. Its transform picks the **bake bounds**, not the data — contours are
stored in world space, so moving the node cannot invalidate an existing path, only make the bake
stale.

```ts
bake: NavBakeSettings
agentRadius: number = 0.4
routes: NavRoute[] ; links: OffMeshLink[]
get/set size: [number, number, number]   // full extents at scale 1; [0,0,0] = whole scene
bakedVolume: [number,number,number,number,number,number] | null
get bounded: boolean                     // true only when all three extents > 0
get invVolumeMatrix: mat4 | null         // world -> unit cube; null when unbounded
volumeBounds(): [...6] | null
get bakeIsStale: boolean                 // false when never baked
get data: NavMeshData ; setData(d): this ; get isBaked: boolean
get mesh: CleoNavMesh | null
route(name: string): NavRoute | null
routePoints(name: string): vec3[]
```

`getBoundingBox()` is overridden to return the world AABB of the **oriented** box.

---

## Lighting and environment

### LightNode — `'light'`

```ts
get light: DirectionalLight | PointLight | Spotlight | AreaLight
get type: 'directional' | 'point' | 'spotlight' | 'area'
get/set castShadows: boolean
get/set bake: boolean      // captured into the light probes (default true); off = live only
bakeSnapshot(): LightBakeSnapshot   // what a probe's bake of it depends on (probeBakeState.ts)
get/set index: number      // record slot; -1 once past MAX_LIGHTS (1024)
```

`probeBakeStaleness(probes, lights)` (core/scene/probeBakeState.ts) lists the baked probes whose bake no
longer matches the lights set to bake that reach them, and what changed (`moved`, `turned`, `colour`,
`intensity`, `range`, `size`, `cone`, `shadows`, `shown`, `added`, `removed`). The editor shows it.

Intensities are photometric: directional in **lux** (default 100000), point, spot and area in **lumens**
(default 1500; 2000 for an area light). See [Rendering (scripting)](../scripting/rendering.md#lights).

An **area light** (`AreaLight`, `lightType: 'area'`) is a glowing rectangle or disk in the light's local XY
plane, emitting along its forward (local +Z, the way a spot points):

```ts
shape: 'rect' | 'disk'      // a disk's diameter is its width
width: number ; height: number   // metres, min 0.01; a disk's height is its width
twoSided: boolean           // both faces, half the lumens each
intensity: number           // lumens out of the whole emitter: radiance = lm / (pi x area x faces)
range: number               // where the window falloff reaches zero, from the centre
area: number ; equivalentRadius: number ; internalRadiance: number   // read-only
```

It is shaded exactly, by linearly transformed cosines (Heitz et al. 2016): the specular highlight is a
picture of the panel and the diffuse is its exact form factor. A one-sided light casts through a spot map
facing its emitting side (75 degrees each way), a two-sided one through a point light's cube; both share
those lights' caps. Deferred, forward PBR, terrain and the GI relight shade it as an area; Blinn-Phong,
cel, lit sprites, lit particles, volumetric fog and custom materials shade it as the spot (one-sided) or
point (two-sided) of the same lumens its record also is. Saved scenes with one need player contract 27.

### LightProbeNode — `'lightProbe'`

Captures local reflections and lighting (irradiance) inside a bounded volume.

```ts
resolution: number ; mode: 'baked' | 'realtime' ; updateFrequency: number
intensity: number ; size: vec3 ; blendDistance: number
affectsLighting: boolean ; affectsReflections: boolean   // both true by default
boxProjection: boolean                 // parallax-correct the reflections against the box (bounded)
get bounded: boolean ; get invVolumeMatrix: mat4 ; get volumeBlend: number
probeWeight(p: vec3): number
distanceToVolume(p: vec3): number      // 0 inside the box (or unbounded)
get volumeSize: number                 // cubic metres; Infinity unbounded
bake(): void                           // a full capture (the scene as a G-buffer), then a relight
relight(): void                        // the captured scene lit again; a probe never captured bakes
get needsBake / needsRelight ; takeBakeRequests(): void ; markBaked(t: number): void
setBakedMaps(source): void ; get bakeVersion: number
get hasBakedMaps / envMap / lastBakeTime
reflectionLayer: number                // its layer of the reflection atlas, -1 while it has none
bakedLights: Map<string, LightBakeSnapshot> | null   // the lights its bake saw (probeBakeState.ts)
get irradianceSH: Float32Array | null   // 9 L2 SH coefficients (rgb, 4 floats apart), radiance form
get shStale: boolean ; setIrradianceSH(sh: Float32Array): void
```

Probes saved before volumes existed deserialize as unbounded.

A capture is shadowed by the key light through a map of its own, fit round the probe
(`ShadowPasses.renderProbeShadows`), and lit only by the lights whose `bake` is on. One probe job runs at
a time (`nextProbeJob`: never baked, then a reflection lost to a regrown atlas, then a bake asked for, then
a relight, then a realtime refresh, nearest first).

Both lobes apply per pixel, whatever the camera does:
- **Lighting.** After a capture, `SkyPasses.updateProbeLighting` projects the capture's ~16-texel mip onto
  radiance spherical harmonics (`irradianceSH`, a frame or two later; the old ones light until then); the
  evaluation's cosine-lobe constants are the diffuse convolution, so no irradiance cube is made. Every
  lighting probe in view, up to 16, is applied per pixel by the deferred pass, the smallest box first and
  unbounded probes last (`render/probeLighting.ts`), the same wherever the camera is. Forward PBR,
  Blinn-Phong and cel draws take the same blend at their bounds' centre; lit particles and lit sprites
  take its mean as their ambient. Never during a capture.
- **Reflections.** A bake GGX-prefilters the capture into one layer of the octahedral reflection atlas
  (`render/reflectionAtlas.ts`, a 2D array; mips are roughness). The deferred pass loops over every
  reflecting probe in view the same way as over the lighting ones, sampling its layer with a dynamic index,
  box-projected when `boxProjection` is on. Forward draws and lit particles take `Scene.probeForPoint`'s
  sharp capture.
- **Bakes** are time-sliced and relightable (`render/probeBaker.ts`, `render/probeJobs.ts`): a bake draws
  the probe's six G-buffer faces through the frame's geometry programs, a draw budget a frame, culled to
  each face; a relight draws the probe's sun shadow, then lights the faces with the deferred pass into the
  source cube; three filter steps prefilter into a free atlas layer and swap it and the
  lights it saw in. One step a frame, one probe at a time. `Renderer.probeBakeProgress` says which.

### WindNode — `'wind'`

The scene's wind, as a vector field: air velocity in m/s at any point and time, the same function on the
CPU (`core/wind/windField.ts`) and the GPU (`chunks/windField.wgsl`). Scene singleton, `scene.wind`. It
follows Ghost of Tsushima: one authored vector (`direction`, `strength`) whose magnitude rides 2D Perlin
noise scrolled along it at `gustSpeed`, `gustScale` metres between crests, so gusts roll across a field;
`gustiness` is how much of the air the gusts carry; a broader noise turns the direction by up to `veer`
degrees either way. Force Fields with `affectsWind` add local wind on top (GoT's "vorticles"), at most 8
at once (`MAX_WIND_SOURCES`).

Foliage samples the field once per plant at its root and leans along the air there; Scene-wind particles
sample it per particle; cloth takes its gusts; volumetric clouds drift with its direction and strength.
Strength 1 is about 7 m/s in a full gust (`WIND_REFERENCE_SPEED`), what wind-enabled materials are
authored for. A scene saved before `gustiness` and `veer` loads with their defaults.

```ts
direction: number                    // degrees the wind blows TOWARD, CCW from +X in XZ (30)
strength: number                     // 0 calm .. 1 authored .. 2 storm (1)
gustScale: number ; gustSpeed: number   // metres between crests (18), m/s they travel (4)
gustiness: number                    // 0..1: 0 a steady stream, 1 still air between gusts (0.8)
veer: number                         // 0..90 degrees the direction wanders either way (20)
fadeStart: number ; fadeEnd: number  // camera distance the foliage motion fades over (40, 70)
get directionXZ: [number, number]    // unit direction in world XZ
sampleAt(position, out?, time?): number[]   // air velocity (m/s) here, Force Field sources included
applyPreset(idOrPreset): boolean     // WIND_PRESETS: calm, lightBreeze, breezy, rollingFields, windy, gale, storm
```

`scene.windAt(position, out?, time?)` is the same reading without a WindNode (the local wind alone).
`time` defaults to `windFieldClock.time`, the renderer's wind clock, so a script reads the gust the plants
are showing. For many samples a frame, capture a `WindFieldSnapshot` once and call its `sample`.

### WeatherNode — `'weather'`

A box of weather (render/weather.ts): wetness, puddles and snow on the landscape
(`chunks/terrainWeather.wgsl`) and on foliage materials, per plant (`chunks/instancedVertex.wgsl`).
Overlapping volumes composite in ascending `priority` (`mix` by each one's weight); at most 4 near the
camera draw a frame. `size` [0, 0, 0] is unbounded, the whole scene (what JSON from before volumes reads
as). With `shelter`, a top-down depth map of the static, solid shadow casters round the camera keeps what
is under them dry (`ShadowPasses.renderShelter`). `scene.weather` is the highest-priority one;
`scene.weatherVolumes` all of them.

**Precipitation.** `precipitation` `'rain'` or `'snow'` makes it fall, through the particle system:
`scene.precipitation` (`PrecipitationRig`) runs ONE system per kind round the camera, built by
`precipitationSystem()` (particles/precipitation.ts) from the ordinary module catalogue, spawning at the
highest `precipitationRate` in reach. Its `weather` module keeps each particle only where the volumes make
that kind fall, as thinly as they do there, and kills it under the shelter map, so overlapping volumes
never double it, a nested dry box carves it out and rain stops at a roof. What falls comes from the sky
above a box: its top face is open (`columnWeightAt`). Rain falls straight at about 8.5 m/s and snow
flutters down at about 1 m/s, both slanted by the scene's WindNode times `precipitationWind`. The
look is the highest-priority such volume's: `precipitationSprite` is a sprite sheet (a tileset's atlas, or
a texture cut `columns` x `rows`), each particle taking a random cell or playing them at `fps`; null is the
engine's own streaks and flakes (`BUILTIN_RAIN_SPRITE`, `BUILTIN_SNOW_SPRITE`, generated, never assets).
While rain falls, the landscape's wet ground stirs: rings run across its puddles and drops hit the ground
round them, by the rain times the wetness, so sheltered ground stays still. The systems are not in the
tree; the renderer draws them beside the scene's own, never in a thumbnail or a probe capture.

```ts
size: [number, number, number]       // [0,0,0] = unbounded ; min 0.01 a side otherwise
blendDistance: number ; priority: number ; enabled: boolean
wetness: number ; snow: number ; puddles: number        // 0..1
snowMaterial: Material | null ; snowMaterialId: string | null   // embedded copy + asset link
snowTiling: number                   // metres per repeat
snowSlope: number                    // degrees
snowBreakup: number                  // 0..1
shelter: boolean
precipitation: 'none' | 'rain' | 'snow'
precipitationRate: number            // 0..1 (0.6)
precipitationSize: number ; precipitationSpeed: number   // multipliers, 0.25..3 (1)
precipitationWind: number            // 0..1: how much scene wind slants it (0.5)
precipitationTrailMin: number ; precipitationTrailMax: number   // rain streak length multipliers, 0.1..4 (0.7, 1.3); min <= max
precipitationSprite: { textureId, tilesetId?, columns, rows, frames, fps } | null   // null = built-in
get bounded: boolean ; get active: boolean ; get precipitating: boolean
get rainRate: number ; get snowfallRate: number          // the rate when it is that kind, else 0
weightAt(p): number ; columnWeightAt(p): number           // columnWeightAt: the top face open
applyPreset(idOrPreset): boolean     // WEATHER_PRESETS: dry, drizzle, rain, storm, lightSnow, snowedIn, blizzard
```

### VolumetricFogNode — `'volumetricFog'`

A box of participating medium drawn by the renderer's froxel fog (`render/volumetricFog.ts`): density
(extinction per metre), albedo, emission, Henyey-Greenstein anisotropy, a height falloff from the box's
bottom face and drifting noise. Lit by the key light (sun or moon, with its cascaded shadow), the clustered
point and spot lights, the sky's ambient, and particle systems' `fogGlow`. Overlapping volumes add; at most
16 draw a frame, by `priority` then distance.

```ts
size: [number, number, number]       // full extents, before the node transform; min 0.01
blendDistance: number ; priority: number ; enabled: boolean
density: number ; albedo: vec3 ; emissiveColor: vec3 ; emissiveIntensity: number   // nits
anisotropy: number                   // -0.9..0.9
heightFalloff: number ; noiseStrength: number ; noiseScale: number ; windVelocity: vec3
sunScattering: number ; localLightScattering: number ; ambientScattering: number
get visibilityDistance: number       // 3.9 / density
weightAt(p): number ; applyPreset(idOrPreset): boolean   // VOLUMETRIC_FOG_PRESETS
```

### GIVolumeNode — `'giVolume'`

A box filled corner to corner with a grid of irradiance probes. The renderer captures what each probe's
rays hit in the static scene (render/gi/), relights those hits as the light changes and applies the
volumes' irradiance per pixel as the most specific indirect diffuse, ahead of the light probes and the sky
light. Forward materials, lit particles and lit sprites take it at their centre.

```ts
size: [number, number, number]           // full extents, before the node transform; min 0.01
probeCounts: [number, number, number]    // probes along each axis, 2..128
probeInset: number                       // 0..0.5 of the spacing the outer probes stand in from the faces (0 = on them)
rays: 64 | 256 ; maxRayDistance: number ; captureResolution: 16 | 32 ; includeGrass: boolean
blendDistance: number ; intensity: number ; normalBias: number ; viewBias: number   // biases: fractions of the smallest spacing
multiBounce: boolean ; enabled: boolean ; bakeId: string | null
additive: boolean                        // added to the light probes' / ambient's / sky light's fill instead of replacing it
requestCapture(): void                   // capture every probe again (the static geometry changed)
gridToWorld(out: mat4): mat4 ; worldToGrid(out: mat4): mat4 ; probeWorldPosition(out, i, j, k)
worldSpacing: [number, number, number] ; minSpacing: number ; probeCount: number
weightAt(p: vec3): number                // 0..1, 0 when disabled
```

Changing the grid (`size`, `probeCounts`, `probeInset`, `rays`, `maxRayDistance`, `captureResolution`) or
the node's transform captures it again; the other fields apply at once. `rays` takes 64 or 256 only; any
other number snaps to the nearer one, with a warning. A volume saved without `probeInset` keeps 0; one added
in the editor starts at 0.5. `renderer.gi` exposes the volumes' state
(`describe()`), the CPU twin (`lightingAt`, `ambientAt`) and `resetLighting()`.

### ExposureVolumeNode — `'exposureVolume'`

A box with its own exposure. While the active camera is inside, the fields in `overrides` replace the
scene's exposure settings (the same names as in `RenderSettings`), blended in by `weightAt(camera)`
over `blendDistance` at the faces. The renderer blends a per-frame copy and never writes it back, so
`getRenderSettings()` and a saved scene keep the scene's own values.

```ts
size: [number, number, number]       // full extents, before the node transform; min 0.01
blendDistance: number ; priority: number ; enabled: boolean
overrides: ExposureOverrides         // a copy; absent fields inherit the scene
setOverride(key, value | undefined) ; hasOverride(key): boolean
applyPreset(idOrPreset): boolean     // AUTO_EXPOSURE_PRESETS: overrides every field the preset sets
weightAt(p: vec3): number            // 0..1, 0 when disabled
```

`ExposureOverrides` fields: `autoExposureEnabled`, `ev100` (manual), `exposureCompensation`,
`exposureCompensationCurve`, `exposureMinEV`, `exposureMaxEV`, `exposureSpeedUp`, `exposureSpeedDown`.
Overlapping volumes apply lowest `priority` first, each blended over the result so far; at equal
priority the smaller box applies last. Scalars blend linearly (the manual exposure in EV); the curve
blends by its output at the metered EV; `autoExposureEnabled` switches at half weight. What is in force
is readable as `renderer.effectiveExposureSettings`.

`affectsLighting` off keeps the probe out of the diffuse lighting inside its volume: surfaces there are
lit by whatever else covers them (another probe, the sky light, the scene ambient) and still take
their reflections from this probe. `affectsReflections` is the converse. Neither needs a re-bake. The
forward-shaded materials only ever take reflections from a probe, so `affectsLighting` changes the
deferred path alone.

### OcclusionVolumeNode — `'occlusionVolume'`

A box whose contents are not rendered while the active camera cannot see the box. Anything whose
world bounds lie wholly inside it belongs to it, found automatically (a light by its position; a
directional light never). The box cannot be seen when it is outside the frustum, behind the landscape,
or found hidden behind what was drawn by a GPU occlusion query; with the camera inside, it is always
seen. A box fitted to a room — its faces halfway into the walls, floor and ceiling, so what rests on
them is inside — therefore skips the room's furniture, lights and effects whenever you cannot see into
it. Only deferred-shaded geometry hides the box from the query; forward-shaded and transparent
surfaces do not. Acts only with `occlusionCulling: 'all'`.

```ts
size: [number, number, number]       // full extents, before the node transform
enabled: boolean
cull: OcclusionVolumeCull            // a copy: models, sprites, particles, lights, decals, fluids, shadows
setCull(key, on) ; culls(key): boolean
renderer.occlusionVolumeStatus(volume): { inside: number, hidden: boolean } | null   // last frame
```

Every `cull` switch is on by default. `shadows` is separate from `models`: with it off, the volume's
models are not drawn but keep casting shadows (a shadow can fall out of the box into view). A hidden
light lights nothing and renders no shadow map; a hidden looping particle system also pauses. Scenes
saved with the old `'occluder'` type load as occlusion volumes of the same size.

### SkyboxNode — `'skybox'`

Six cube faces. `get skybox: Skybox`, `initializeSkybox()`. Mutually exclusive with Sky Atmosphere —
adding one removes the other.

### SkyAtmosphereNode — `'skyAtmosphere'`

Physically-based sky, baked to a cubemap whenever the sun moves.

Option groups: **sun** (`useSceneSun`, `sunDirection`, `sunColor`, `sunIntensity`, `physicalUnits`), **atmosphere**
(`rayleighScatter`, `rayleighHeight`, `mieScatter`, `mieHeight`, `mieG`, `planetRadius`,
`atmosphereRadius`, `sunDiskSize`, `exposure`, `groundColor`), **quality** (`resolution`,
`viewSteps`, `lightSteps`), **fog** (`fogEnabled`, `fogDensity`, `fogStart`, `fogHeight`,
`fogHeightFalloff`, `fogMaxOpacity`, `fogColor`, `fogColorBlend`), **god rays** (`godRaysEnabled`,
`godRaySamples`, `godRayDensity`, `godRayExposure`, `godRayTint`, `godRayAnisotropy`,
`godRayMaxDistance`), **moon** (`moonEnabled`, `moonPhase`, `moonSize`, `moonOffsetYaw`,
`moonOffsetPitch`, `moonColor`, `moonIntensity`, `moonIlluminance`).

`moonIlluminance` is the moon's light in lux (default `DEFAULT_MOON_LUX`, 1), independent of the sun's:
the key light becomes the moon at that illuminance once the sun has set. A payload saved before it
carries the legacy `moonlightIntensity`, a fraction of the sun's lux, and keeps it until
`moonIlluminance` is set; `moonLux(sunLux)` returns whichever is in force.

`physicalUnits` (new skies: true; saved skies without it: false) lights the sky with the scene sun's
own lux, divided by `REFERENCE_ILLUMINANCE`, instead of `sunIntensity`, times
`SkyPasses.PHYSICAL_SKY_CALIBRATION` (3): the single-scattering march, calibrated to measured clear-sky
light. Its march converges — it stops 12 scale heights up and steps quadratically — so `planetRadius` and
`atmosphereRadius` shape the horizon without starving the integral; an artistic sky keeps the even march
its `sunIntensity` was tuned against. The sun and moon discs then take the radiance their illuminance spreads over their
size, and `exposure` is a trim on top. It
needs `useSceneSun` and a directional light.

> Writing `sunDirection`, `sunColor`, `sunIntensity`, `exposure` or `groundColor` sets the re-bake
> flag **unconditionally**, ahead of the ~0.3° angular throttle. Touch any of them every frame and
> you bake six cube faces plus a mip chain every frame. To animate a sun, rotate the directional
> light and let `useSceneSun` read it — on a timer, not per frame.

### SkyLightNode — `'skyLight'`

Ambient light projected from the sky.

```ts
intensity: number ; tint: vec3 ; cloudResponse: number   // 0..1
ambient: number        // x the scene's flat ambient (Scene settings), default 1
nightAmbient: number   // 0..1, share of that ambient kept after sunset; new: DEFAULT_NIGHT_AMBIENT (1e-4), saved without it: 1
ambientScale(sunElevationSin: number | null): number
get needsProjection: boolean
markDirty(): void ; markProjected(): void
```

The scene's flat ambient (`Scene.ambientLight`, lux) is added to every shaded pixel and does not
darken with the sky. With a sky light in the scene, the renderer scales it by `ambientScale`: `ambient`
always, and `nightAmbient` faded in by `nightFactor` of the sun's elevation (full from about 8° below
the horizon). The sun is the Sky Atmosphere's baked sun, or else the first directional light. Set
`nightAmbient` near 0 and a moonless night goes almost black while the day keeps its fill. A scene with
a Sky Atmosphere but no sky light fades the flat ambient the same way, by `DEFAULT_NIGHT_AMBIENT`; a
scene with no sky at all (a dungeon) keeps it.

> The spherical-harmonic projection decides it is stale by comparing cubemap **object identity**,
> and a sky re-bake renders into the same texture. So indirect light freezes at the first sun
> position unless something calls `markDirty()`. If you animate the sun, call it periodically.

### VolumetricCloudsNode — `'volumetricClouds'`

Raymarched clouds. Option groups: **shape** (`coverage`, `density`, `cloudType`, `baseAltitude`,
`thickness`, `baseScale`, `detailScale`, `detailStrength`, `curlStrength`, `anvilBias`),
**lighting** (`useSceneSun`, `sunDirection`, `sunColor`, `sunIntensity`, `ambientColor`,
`ambientIntensity`, `groundColor`, `sunsetColor`, `phaseG`, `silverIntensity`, `silverSpread`,
`powderStrength`, `absorption`), **animation** (`windDirection`, `windSpeed`, `detailWindFactor`),
**quality** (`steps`, `lightSteps`, `maxDistance`, `jitter`, `resolutionScale`, `temporalUpscale`),
**render** (`enabled`, `opacity`).

### DecalNode — `'decal'` *(unreleased)*

A decal volume, the way Unreal's DecalActor and HDRP's Decal Projector work: an oriented box that
projects a material onto every surface inside it. A decal has no geometry of its own. It takes the
shape of whatever it overlaps, so a scorch mark wraps over a kerb and a painted line follows the
terrain.

**The box.** `size` is the full extent at scale 1, so the volume is `worldTransform × scale(size)`
over the unit cube `|xyz| ≤ 0.5`, the same convention as the [light probe](#lightprobenode--lightprobe)'s
box. The decal projects along local **−Y**, so an unrotated decal lands on the ground beneath it.
The image lies in local XZ, with `u = 0.5 + x` and `v = 0.5 − z`. Seen from above, +X runs right and
−Z runs up the image, so a texture reads the right way round on a floor. A surface is touched only
where it lies inside the box **and** faces the projector.

| Field | Default | Meaning |
|---|---|---|
| `size` | `[1, 1, 1]` | Full extents. Each axis is made positive and kept at `0.001` or more, since a flat box has no inverse. To mirror a decal, use the node's scale. |
| `material` | `null` | The projected material. **PBR only**: anything else logs a warning and is stored as `null`. `null` projects plain white. |
| `opacity` | `1` | Coverage multiplier, `0..1`. |
| `sortOrder` | `0` | Integer. Where decals overlap, higher lands on top. Ties break by id, never by distance. |
| `angleFade` | `0.3` | Fade on surfaces turned away from the projector: the weight is `smoothstep(0, angleFade, dot(N, boxY))`, where `boxY` is the box's own +Y axis. `0` disables the test, and the decal then lands on walls and back faces inside the box too. |
| `depthFade` | `0.2` | Feather toward the box's top and bottom faces, as a fraction of its half-height. `0` is a hard cut. |
| `affects` | all `true` | `{ albedo, normal, surface, emissive }`. `surface` is roughness, metallic and AO under **one** coverage, as in Unreal's DBufferC. |
| `receivers` | `'all'` | `'terrain'` keeps the decal off everything but landscapes. See below. |
| `pattern` | `'material'` | `'radial'` draws the procedural gradient in `radial` instead of the material. |
| `radial` | see below | The gradient's parameters. The setter accepts a `Partial`. |
| `albedoOpacity` | `1` | The albedo's share of the coverage, `0..1`. Roughness, metallic, AO and the normal keep the full coverage, so a near-black base colour at `0.3`–`0.5` darkens the ground under it while its roughness turns wet: a film of clear liquid. |
| `flipbook` | `null` | `{ columns, rows, frames, fps, loop, blend }`: play the material's maps as an atlas, every map from the same cell, left to right from the top row. See below. |

`affects` and `radial` return live objects, so you can mutate them in place. From the material, a
decal reads the base colour, whose alpha times the material's `opacity` is the coverage. It also
reads the normal map, the ORM maps or the roughness/metallic scalars, the emissive colour and map,
and the mask map's red channel, which scales coverage. Height, parallax and cutout settings do not
apply.

```ts
get volumeMatrix: mat4 ; get invVolumeMatrix: mat4   // unit cube <-> world; live scratch, copy to keep
get mirrored: boolean        // det(worldTransform) < 0: the renderer culls the other face set
get writesSurface: boolean   // albedo, surface, or a normal map to write
get emits: boolean           // affects.emissive, and something non-zero to emit
```

**Flipbooks.** The clock is the decal's own: `flipbookTime` starts at 0 on its first update in play and
runs on scaled game time (slow motion and hit-stop slow it too); `playFlipbook()` restarts it. Before it
has ever played (`flipbookTime` is `Infinity`: the editor, a thumbnail) the last frame shows, so a
one-shot is seen as it ends. Without `loop` the last frame holds; `blend` cross-fades each frame into the
next. The FX Creator's liquid floor decals are such atlases, with the block to play them in their sidecar.
`decalFlipbookFrame(flipbook, time)` is the cell maths as a pure function.

`getBoundingBox()` and `getBoundingSphere()` are overridden to use the box's eight corners, so
changing `size` moves the bounds and frustum culling follows. `scene.decals` is the scene's typed
set. A decal serializes under one nested `decal` key, material included, and a missing or malformed
key reads back as its default. `decalLocalToUV(local)`, `radialDecalT(local, shape)` and
`radialDecalWeight(t, exponent, curve, falloff)` are the shader's projection and gradient maths as pure
functions.

**How it renders.** Every route draws the box's back faces with no depth test and rebuilds the
surface position from the depth buffer. That is what lets the camera stand inside the box.

| Route | When | Lands on |
|---|---|---|
| **Surface**: albedo, normal, roughness/metallic/AO | After the geometry pass, before SSAO and lighting. Written into a three-target DBuffer, then resolved into the G-buffer, so the decal is **lit** like the surface underneath. | **Deferred receivers only**: PBR meshes, landscapes, foliage and deferred custom materials. |
| **Emissive** | After lighting, added to the image before fog. As bright as a mesh wearing the same material. It blooms wherever the surface underneath would, because the bloom mask is left untouched. | **Every opaque surface**, including forward-shaded ones. |
| **Overlay** | Used **instead of** the other two routes for an editor-only decal (`markEditorOnly`). Drawn as unlit chrome in the editor overlay layer after the post chain, using the un-jittered camera so it does not shimmer under TAA. The landscape brush is drawn this way. | Every opaque surface. Never in a build. |

The passes are labelled `decals.receivers`, `decals` and `decals.resolve`, `decals.emissive`, and
`overlay.decals`. You can switch `decals` and `decals.emissive` off from the profiler.

**`receivers: 'terrain'`** keeps a rock or a grass blade standing inside the box clean, on every
route. It costs one depth-only pass over the landscape chunks in any frame where such a decal is
visible. A pixel counts as terrain when its depth matches the terrain-only depth to within
`0.02 + 0.002·d` world units, where `d` is the distance from the camera. That is 4 cm at 10 m and
22 cm at 100 m. Anything within that margin of the ground, like the foot of a rock, still takes the
decal.

**The radial pattern** is a procedural gradient for ground indicators: an area-of-effect ring, a
selection circle, the editor's terrain brush. `t` is the distance from the box's vertical axis as a
fraction of its half-width, which makes an ellipse when the box is not square; with `shape: 'square'`
it is the Chebyshev distance instead, and the pattern fills the box's footprint. Nothing lands past
`t = 1`:

```ts
w     = radialDecalWeight(t, exponent, curve, falloff)   // 'power': exponent <= 0 ? 1 : pow(1 - t, exponent)
color = mix(outerColor, innerColor, w)
```

| Field | Default | Meaning |
|---|---|---|
| `innerColor` | `[1, 1, 1, 1]` | Colour and coverage at the centre (`w = 1`). |
| `outerColor` | `[1, 1, 1, 0]` | Colour and coverage at the rim (`w = 0`). |
| `curve` | `'power'` | `'power'` is `pow(1 − t, exponent)`. `'smooth'`, `'linear'`, `'sphere'` and `'tip'` hold full weight over the inner `1 − falloff` of the radius, then fall to `0` at the rim with that profile. |
| `exponent` | `1` | The `power` curve's exponent. `0` is a flat, uniform disc. |
| `falloff` | `0.5` | The other curves' falloff: the fraction of the radius the weight falls over. `0` is a hard edge. |
| `shape` | `'circle'` | `'circle'` or `'square'`. Rotate the node to turn a square. |
| `ringColor` | `[1, 1, 1, 0]` | An outline just inside `t = 1`. Alpha `0` disables it. |
| `ringWidthPx` | `1.5` | Ring width in screen **pixels**, so it stays crisp at any distance. |
| `emissive` | `0` | Multiplier on the pattern colour for the emissive route. `0` means not emissive. |

Colours are RGBA `0..1` and **sRGB-authored**, like every picker colour. The curves are the terrain
brush's own: `radialDecalWeight(t, brushFalloffExponent(f))` equals `curveWeight(t, f, 'soft')`, and each
band curve equals `curveWeight` of the same name, so the brush cursor shows exactly what the next stroke
will do.

> **Known limits.**
>
> - **No surface decals on forward-shaded surfaces.** Blinn-Phong (`Material.Default`, which every
>   Add-catalog primitive starts with), Cel and forward custom materials are lit straight into the
>   image after the G-buffer is resolved, so there is nothing for the decal to write into. They
>   still receive the emissive route. Unlit Basic surfaces are skipped by the surface route as
>   well: zero albedo is how the G-buffer marks a pixel unlit, and a decal giving it albedo would
>   light it. A PBR surface whose base colour is exactly black shares that marker and is skipped too.
> - **Transparent surfaces receive nothing.** The decal lands on the opaque surface behind them.
> - **No surface decals in the forward pipeline** (`graphics.deferred: false`), which has no
>   G-buffer. Emissive and overlay decals still work there. **No decals at all in light-probe
>   captures**, so a decal never shows up in a probe's reflections.
> - **No per-object opt-out.** There is no stencil buffer to carry a "receives decals" flag, so
>   `receivers: 'terrain'` is the only filter.
> - **The image is shown once, never tiled.** Decal textures are sampled at least half a texel inside
>   their edges, so a repeat-wrapped texture cannot bleed its opposite edge in along the box border.
>   A texture's wrap mode has no effect on a decal.

---

## Terrain and 2D

### LandscapeNode — `'landscape'`

```ts
get terrain: Terrain
setTerrain(t: Terrain): void
updateLod(camPos: vec3, settings: TerrainLodSettings): void
```

Its generated chunk children are excluded from serialization. Runtime API:
[Terrain and tilemaps](../scripting/terrain-tilemap.md).

### TilemapNode — `'tilemap'`

```ts
get tilemap: Tilemap
setTilemap(t: Tilemap): void
```

### SpriteNode — `'sprite'`

```ts
get sprite: Sprite
get/set constraints: 'free' | 'spherical' | 'cylindrical'    // billboarding (render/billboard.ts)
tileset: string ; tileIndex: number ; tint: vec3 ; opacity: number
sprite.blend: 'alpha' | 'additive'                           // additive adds light: fire, glows
sortingOrder: number                                         // higher draws on top; 0 = by depth
pivot: [number, number]                                      // the image point at the origin: 0,0 bottom-left
flipX: boolean ; flipY: boolean                              // mirror the image about the pivot
quadMatrixInto(out: mat4, camera: Camera): mat4              // the quad as drawn: billboarded, sized, pivoted
uvRect(): [number, number, number, number]
initializeSprite(): void
```

A sprite whose tileset has **pixels per unit** is its tile's pixel size over that many pixels per unit,
times its scale; without it, a unit quad sized by its scale.

### ParallaxLayerNode — `'parallaxLayer'`

Extends `SpriteNode`: a 2D backdrop that moves with part of the camera's travel and tiles to fill the view.

```ts
parallax: [number, number]      // share of the camera's travel it moves with: 1 the world, 0 the screen
repeatX: boolean ; repeatY: boolean   // tile along the axis (the tileset must be the one whole image)
scroll: [number, number]        // a drift of its own, units per second
```

Never picked in the viewport.

### Camera2DNode — `'camera2D'`

Extends `CameraNode`: the 2D game camera. Orthographic, sized in art pixels, following a node through rooms.

```ts
pixelsPerUnit: number                      // art pixels per world unit (16)
referenceResolution: [number, number]      // the view in art pixels, at least, at zoom 1 (480 x 270)
zoom: number ; pixelPerfect: boolean       // pixel-perfect: whole screen pixels per art pixel
followTarget: string                       // the NAME of the node to follow
followOffset: [number, number] ; deadzone: [number, number]
damping: number ; lookAhead: number
confineToRooms: boolean ; roomTransitionSeconds: number
get room: Room2DNode | null ; get inRoomTransition: boolean
get layout: { scale, virtualWidth, virtualHeight }   // the last frame's fit
shake(amplitude: number, seconds?: number, frequency?: number): void
snapToTarget(): void                        // jump to the target, no damping or slide (after a respawn)
fitView(width: number, height: number)      // called by the renderer each frame
```

It moves in the scene's late pass, only while the game plays.

### CharacterBody2DNode — `'characterBody2D'`

A 2D character's body: a box standing on its feet at the node, moved by the 2D physics.

```ts
size: [number, number] ; layer: number ; stepHeight: number ; flipSprites: boolean
controller: 'platformer' | 'none' ; playerInput: boolean
moveAction ; jumpAction ; dashAction: string
settings: PlatformerSettings ; abilities: { doubleJump, dash, wallJump }
gravity: number                                    // with no controller
velocity2D: [number, number]
get isGrounded ; onWall ; onCeiling ; onSlope ; facing ; isDashing ; isWallSliding
get justJumped ; justDashed ; justLanded
move(x, y?) ; jump() ; releaseJump() ; dash() ; teleport(x, y)
```

### Body2DNode — `'body2D'`

```ts
size: [number, number] ; kind: 'solid' | 'oneWay' ; enabled: boolean
bounds(out?): [minX, minY, maxX, maxY]
```

### Area2DNode — `'area2D'`

```ts
size: [number, number] ; offset: [number, number] ; layer: number ; mask: number
detectAreas: boolean ; enabled: boolean
```

### Room2DNode — `'room2D'`

```ts
size: [number, number]          // the whole rectangle, world units, centred on the node
zone: string                    // a free label
bounds(out?): [minX, minY, maxX, maxY]
contains(x: number, y: number): boolean
```

The followed node and the room hear `onRoomEnter(other)` / `onRoomExit(other)` when the node crosses
into or out of it ([Lifecycle](../scripting/lifecycle.md)).

### AnimatedSpriteNode — `'animatedSprite'`

Extends `SpriteNode`.

```ts
frames: number[] ; frameSource: 'node' | 'tile'
fps: number ; loop: boolean ; randomStart: boolean   // randomStart: each copy begins on a random frame
get currentTile: number ; get/set currentFrame: number
reset(): void
animationSet: SpriteAnimationSet | null ; animationSetId: string | null   // clips + optional state machine
play(name, restart?) ; resumeMachine() ; setParam(name, value) ; fireTrigger(name)
get clip ; state ; isFinished ; normalizedTime ; clipFrame ; clipNames
speed: number ; paused: boolean
```

---

## Audio

### SoundNode — `'sound'`

```ts
play(): void ; stop(): void ; pause(): void ; resume(): void
fadeTo(volume: number, seconds: number): void
get isPlaying: boolean
syncSpatial(): void
```

Properties: `mode` (`'ambient' | 'spatial'`), `sampleId`, `volume`, `loopMode`
(`'inherit' | 'on' | 'off'`), `playOnStart`, `spatial`, plus the shortcuts `distanceModel`,
`refDistance`, `maxDistance`, `rolloffFactor`.

> `play()` is a silent no-op when `scene.soundsEnabled === false`.

### ParticleSystemNode — `'particleSystem'` *(unreleased)*

Plays an embedded particle system definition (see [Particles](../editor/particles.md)). The node owns
the clock and spawn ring; the renderer owns the GPU state and drains the node's queued steps each
frame. Nothing is read back, so `isAlive` comes from the clock, not a particle count.

```ts
play(): void ; pause(): void ; resume(): void ; restart(): void
stop(clear?: boolean): void          // clear: remove every particle at once
burst(count: number, emitterName?: string): void
setSystem(def: ParticleSystemDef, restart?: boolean): void
get isPlaying: boolean ; get isPaused: boolean ; get isAlive: boolean
```

Properties: `system` (read-only; replace through `setSystem`), `particleSystemId` (the `.vfx` it
mirrors, or null), `playOnStart`, `simulationSpeed`, `spawnRateScale`, `tint` (linear RGBA).
`setSystem` keeps live particles when every pool keeps its shape and rebuilds otherwise.

> While the editor is authoring, a system neither simulates nor draws when
> `scene.particlePreview === false`.

### ForceFieldNode — `'forceField'` *(unreleased)*

A volume that pushes particles of emitters with the Force Fields module. Up to 16 act at once.

Properties: `kind` (`'directional' | 'radial' | 'vortex' | 'turbulence' | 'drag'`), `shape`
(`'global' | 'sphere' | 'box'`), `strength`, `radius`, `extents` (box half extents), `falloff`
(0..1), `frequency` (turbulence), `enabled`, `affectsWind`. Direction and vortex axis are the node's
local +Y; a box is axis-aligned in the world.

With `affectsWind` the field is also local WIND: it joins the WindNode's field, so foliage bends to it,
Scene-wind particles ride it and `windAt` reads it. In wind terms strength is air speed in m/s —
directional along +Y, radial toward the centre (negative is a blast), vortex round +Y with a calm eye a
fifth of the size, turbulence the speed of divergence-free eddies carried by the wind — and for drag the
fraction of the wind it blocks (a shelter). The first 8 such fields count; particle passes list them
first, so foliage, particles and the CPU see the same ones. The Wind presets (`gustCorridor`,
`whirlwind`, `windBlast`, `windEddies`, `windShelter`) set it.

### ClothNode — `'cloth'` *(unreleased)*

A rectangular cloth panel simulated on the CPU (XPBD): a cape, a banner, a flag. A `ModelNode` underneath,
so it draws, shadows and takes a material like one; its mesh is rebuilt from its options and never saved.
It simulates while the scene plays and shows its rest shape while authoring. The panel lies in the node's
local XY plane, hanging down −Y.

Options (`node.options`, changed with `node.setOptions({...})`): `width`, `height` (metres),
`columns`, `rows` (particles, 2..64), `pinEdge` (`'top' | 'left' | 'none'`), `stiffness`, `bend`,
`damping` (0..1), `mass` (kg), `thickness` (metres kept off colliders), `windResponse` (multiplier on
the scene's `WindNode`), `collideWithOwner` (the ragdoll capsules of the character it hangs from),
`bone` (a humanoid slot such as `'chest'`, or a bone name: the held edge rides that bone instead of the
node), `enabled`. `particlePositions` is the simulated world positions, or null at rest.

### WaterVolumeNode — `'waterVolume'` *(unreleased)*

A body of water: an axis-aligned box (the node's rotation is ignored, scale multiplies `size`) whose
**top face is the water surface**. Every dynamic physics body inside is buoyed by Archimedes' principle —
its colliders are sampled, and each submerged sample is pushed up by the weight of the water it
displaces, at that point — so whether a body floats, and how low it rides, follows from its **mass**
against its collider volume, and a tipped body rights itself. Submerged bodies also get linear and
angular drag. Character bodies are skipped unless `affectCharacters` (a capsule is mostly air).

Properties: `size` (full extents, metres), `density` (kg/m³, default 1000), `linearDrag`,
`angularDrag` (per second at full submersion), `waveAmplitude` / `waveFrequency` (a swell that makes
floaters bob), `affectCharacters`, `surfaceNodeId`, `splashTemplate`, `wadeSplashTemplate`, `enabled`. Helpers:
`worldBox()`, `surfaceHeightAt(x, z, t)`, `contains(p)`, `depthAt(p)`.

In play it also disturbs its surface: if the `surfaceNodeId` model's custom material declares vec4
uniforms `ripple0`..`ripple11`, they are filled each frame with expanding rings (`[x, z, startTime,
strength]`, startTime on `u_time`'s clock) from characters wading and bodies floating or splashing in;
and `splashTemplate`, when set, is instantiated at the surface where something enters or wades --
`wadeSplashTemplate`, when set, for the steps of a character wading (every 0.45 s while it moves).

---

## UI

Eleven types. Screen-space UI **ignores `Node.position` / `rotation` / `scale` entirely** — layout
is an anchor pair plus two offsets, as in Unity's `RectTransform`. Only a world-space `UIRootNode`
uses the node transform. UI is also the only node family that persists `visible`.

Authored properties shared by every UI node: `anchorMin`, `anchorMax`, `offsetMin`, `offsetMax`,
`pivot`, `rotationDeg`, `scale2d`, `opacity`, `tint` (**sRGB 0..1 RGBA**, not linear), `zOrder`,
`interactive`, `clip`, `sizing` (`'fixed' | 'content'`), `padding`, `borderRadius`, `borderWidth`,
`borderColor`. Helpers: `setRect(x, y, w, h)`, `setAnchor(x, y)`, `stretch(l, t, r, b)`.

Resolved, read-only, and **live objects rewritten in place**: `rect`, `localRect`, `screenRect`,
`clipRect`, `resolvedOpacity`, `resolvedVisible`, `onScreen`, `layoutVersion`, `revision`,
`measuredContentSize`, `uiChildren`.

| Type | `nodeType` | Own API |
|---|---|---|
| `UIRootNode` | `uiRoot` | `space: 'screen' \| 'world'`, `referenceResolution = [1920, 1080]`, `scaleMode: 'constantPixel' \| 'scaleWithScreen' \| 'constantPhysical'`, `matchWidthOrHeight`, `referenceDpr`; world-space: `uiTargetId`, `referenceDistance`, `minScale`, `maxScale`, `billboard`, `clampToScreen`, `hideBehindCamera`; readouts `scaleFactor`, `origin`, `offscreen`, `edgeAngleDeg`, `planeMatrix` |
| `UIPanelNode` | `uiPanel` | A rectangle. Container and background. |
| `UIStackNode` | `uiStack` | `direction: 'row' \| 'column'`, `gap`, `justify`, `align: 'start' \| 'center' \| 'end' \| 'stretch'`, `reverse` |
| `UISpacerNode` | `uiSpacer` | `flex` |
| `UITextNode` | `uiText` | `text`, `fontSize`, `fontFamily`, `fontWeight`, `align`, `vAlign`, `wrap`, `lineHeight`, `letterSpacing` (em) |
| `UIImageNode` | `uiImage` | `textureId`, `fit: 'fill' \| 'contain' \| 'cover' \| 'tile'`, `uvRect` |
| `UIButtonNode` | `uiButton` | `label`, `disabled`, `hoverTint`, `pressedTint`, `disabledTint`; handler **`onPress()`**; `press()` |
| `UIProgressBarNode` | `uiProgressBar` | `min`, `max`, `value`, `fillTint`, `direction: 'ltr' \| 'rtl' \| 'btt' \| 'ttb'`, `smoothing`, `get fraction` |
| `UISliderNode` | `uiSlider` | `min`, `max`, `step`, `value`, `fillTint`, `handleTint`, `vertical`, `get fraction`; handler **`onValueChanged(value)`**; `setValueFromFraction(f)` |
| `UIToggleNode` | `uiToggle` | `checked`, `label`, `onTint`, `offTint`; handler **`onValueChanged(checked)`**; `toggle()` |
| `UITextInputNode` | `uiTextInput` | `value`, `placeholder`, `maxLength`, `password`, `readOnly`, `fontSize`; handlers **`onValueChanged(value)`**, **`onSubmit(value)`**; `setValueFromInput(next)`, `submit()` |

> Assigning `value` on a slider or toggle **does not** fire `onValueChanged` — only user input
> does. That is what stops a script that mirrors a value into a widget from re-entering itself.

## See also

[Node API](../scripting/node-api.md) · [API index](api-index.md) · [Add catalog](../editor/scene-authoring.md#the-add-catalog)
