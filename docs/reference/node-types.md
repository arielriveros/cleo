# Reference — node types

Every node class, the `nodeType` string it serializes as, and its own API. The base `Node` API that
all of them inherit is documented in [Node API](../scripting/node-api.md) and is not repeated here.

The `nodeType` strings are persisted in saved scenes. Adding one is safe; renaming one breaks
existing saves — which is why some names look dated.

```ts
type NodeType =
  | 'node' | 'model' | 'light' | 'lightProbe' | 'skybox' | 'camera' | 'sprite' | 'animatedSprite'
  | 'landscape' | 'tilemap' | 'volumetricClouds' | 'skyAtmosphere' | 'skyLight' | 'lodGroup'
  | 'cameraRig' | 'sound' | 'character' | 'controller' | 'navMesh'
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
