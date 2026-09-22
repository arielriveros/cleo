# Reference — node types

Every node class, the `nodeType` string it serializes as, and its own API. The base `Node` API that
all of them inherit is documented in [Node API](../scripting/node-api.md) and is not repeated here.

The `nodeType` strings are persisted in saved scenes. Adding one is safe; renaming one breaks
existing saves — which is why some names look dated.

```ts
type NodeType =
  | 'node' | 'model' | 'light' | 'lightProbe' | 'skybox' | 'camera' | 'sprite' | 'animatedSprite'
  | 'landscape' | 'tilemap' | 'volumetricClouds' | 'skyAtmosphere' | 'skyLight' | 'lodGroup'
  | 'cameraRig' | 'sound' | 'character' | 'controller' | 'navMesh' | 'decal'
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
`collisionReturnTime` / `collisionIgnoreIds`, `shakePositionAmplitude`, `shakeRotationAmplitude`,
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
get light: DirectionalLight | PointLight | Spotlight
get type: 'directional' | 'point' | 'spotlight'
get/set castShadows: boolean
get/set index: number      // record slot; -1 once past MAX_LIGHTS (1024)
```

Intensities are photometric: directional in **lux** (default 100000), point and spot in **lumens**
(default 1500). See [Rendering (scripting)](../scripting/rendering.md#lights).

### LightProbeNode — `'lightProbe'`

Captures local reflections and irradiance inside a bounded volume.

```ts
resolution: number ; mode: 'baked' | 'realtime' ; updateFrequency: number
intensity: number ; size: vec3 ; blendDistance: number
get bounded: boolean ; get invVolumeMatrix: mat4 ; get volumeBlend: number
probeWeight(p: vec3): number
bake(): void ; markBaked(t: number): void
setBakedMaps(source, irradiance, prefiltered): void
get hasBakedMaps / irradiance / prefiltered / envMap / needsBake / lastBakeTime
```

Probes saved before volumes existed deserialize as unbounded.

### SkyboxNode — `'skybox'`

Six cube faces. `get skybox: Skybox`, `initializeSkybox()`. Mutually exclusive with Sky Atmosphere —
adding one removes the other.

### SkyAtmosphereNode — `'skyAtmosphere'`

Physically-based sky, baked to a cubemap whenever the sun moves.

Option groups: **sun** (`useSceneSun`, `sunDirection`, `sunColor`, `sunIntensity`), **atmosphere**
(`rayleighScatter`, `rayleighHeight`, `mieScatter`, `mieHeight`, `mieG`, `planetRadius`,
`atmosphereRadius`, `sunDiskSize`, `exposure`, `groundColor`), **quality** (`resolution`,
`viewSteps`, `lightSteps`), **fog** (`fogEnabled`, `fogDensity`, `fogStart`, `fogHeight`,
`fogHeightFalloff`, `fogMaxOpacity`, `fogColor`, `fogColorBlend`), **god rays** (`godRaysEnabled`,
`godRaySamples`, `godRayDensity`, `godRayExposure`, `godRayTint`, `godRayAnisotropy`,
`godRayMaxDistance`).

> Writing `sunDirection`, `sunColor`, `sunIntensity`, `exposure` or `groundColor` sets the re-bake
> flag **unconditionally**, ahead of the ~0.3° angular throttle. Touch any of them every frame and
> you bake six cube faces plus a mip chain every frame. To animate a sun, rotate the directional
> light and let `useSceneSun` read it — on a timer, not per frame.

### SkyLightNode — `'skyLight'`

Ambient light projected from the sky.

```ts
intensity: number ; tint: vec3 ; cloudResponse: number   // 0..1
get needsProjection: boolean
markDirty(): void ; markProjected(): void
```

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
get/set constraints: 'free' | 'spherical' | 'cylindrical'    // billboarding
tileset: string ; tileIndex: number ; tint: vec3 ; opacity: number
uvRect(): [number, number, number, number]
initializeSprite(): void
```

### AnimatedSpriteNode — `'animatedSprite'`

Extends `SpriteNode`.

```ts
frames: number[] ; frameSource: 'node' | 'tile'
fps: number ; loop: boolean
get currentTile: number ; get/set currentFrame: number
reset(): void
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
| `UITextNode` | `uiText` | `text`, `fontSize`, `fontFamily`, `fontWeight`, `align`, `vAlign`, `wrap`, `lineHeight` |
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
