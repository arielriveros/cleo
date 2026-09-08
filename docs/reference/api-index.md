# Reference — API index

Everything exported from the `cleo` module, grouped. This is what
`import { … } from 'cleo'` resolves to inside a script.

Types are marked *(type)*; everything else is a value you can call, construct or read. Most of what
a game needs is in the first four sections — the rest exists because the editor is written against
the same API your scripts are.

---

## Engine and scene

| Export | What it is |
|---|---|
| `VERSION` | The product version string. |
| `CleoEngine` | The engine host: initialize, run, set the viewport and scene, pause. |
| `Scene` | A node tree plus its systems. See [Scene and game](../scripting/scene-and-game.md). |
| `InstantiateOptions` *(type)* | `{ parent?, name?, position?, rotation?, scale? }` for `scene.instantiate`. |
| `Game`, `setGameHost`, `GameHost` *(type)* | The script-facing session facade: load a scene, pause, read time and gravity, read and update render settings. |
| `Camera` | The projection/view pair a `CameraNode` owns. |
| `Geometry` | Mesh data and the primitive factories. |
| `Node`, `NodeType` *(type)*, `MotionBlurMode` *(type)* | The base node. |
| `parseNodeJson` | Materialize a node subtree from JSON, dispatching to the right subclass. |
| `cloneNodeJson`, `collectNodeIds`, `remapNodeRefs`, `regenerateNodeIds` | Node-JSON surgery, typed-array aware. |
| `registerTemplates`, `clearTemplates`, `getTemplate`, `templateNames`, `NodeTemplate` *(type)* | The template (prefab) registry. |
| `isEditorOnlyNode`, `markEditorOnly` | Flag a node as editor chrome. |
| `Logger`, `LogEntry` / `LogMethod` / `LogOptions` *(types)* | Categorised logging that reaches the editor console. |
| `TypedEmitter`, `engineEventBus`, `EngineEventMap` / `SceneChange` / `ChangeKind` / `StructureOp` / `NodePlacement` *(types)* | The engine event bus. |
| `HistoryManager`, `HistoryEntry` / `HistoryOptions` *(types)* | Undo/redo. |
| `sceneStats`, `sceneStatsDetail`, `SceneStats` *(type)* | Per-frame scene cost breakdown. |

## Nodes

`ModelNode`, `disposeModelSubtree`, `LodGroupNode`, `CameraNode`, `CameraRigNode`
(+ `FollowSpace` / `AimMode` *(types)*), `CharacterNode`, `ControllerNode`
(+ `CONTROL_SOURCES`, `AIM_SOURCES`, `BRAIN_KINDS`, and `BrainKind` / `ControlSource` / `AimSource`
/ `BlackboardValue` *(types)*), `NavMeshNode`, `LightNode`, `LightProbeNode`, `SkyboxNode`,
`SkyLightNode` (+ `SkyLightOptions`), `SkyAtmosphereNode` (+ `SkyAtmosphereOptions`),
`VolumetricCloudsNode` (+ `VolumetricCloudsOptions`), `LandscapeNode`, `TilemapNode`, `SpriteNode`,
`AnimatedSpriteNode` (+ `SpriteFrameSource`), `SoundNode` (+ `SoundMode` / `SoundNodeOptions` /
`LoopMode`).

Full details: [Node types](node-types.md).

## UI

Classes: `UINode`, `UIRootNode`, `UIPanelNode`, `UIStackNode`, `UISpacerNode`, `UITextNode`,
`UIImageNode`, `UIButtonNode`, `UIProgressBarNode`, `UISliderNode`, `UIToggleNode`,
`UITextInputNode`. Plus `isUINodeType`.

Types: `UIImageFit`, `UIFillDirection`, `UITextAlign`, `UITextVAlign`, `UISizing`, `UIColor`,
`UIRect`, `UIScaleMode`, `UISpace`, `StackJustify`, `StackItem`, `ScreenProjection`.

Layout helpers: `uiSetRect`, `uiSolveRect`, `uiRootScale`, `uiProjectToScreen`, `worldUIScale`,
`uiIntersectRect`, `uiRectOffscreen`, `uiStackLayout`.

## Scripting

| Export | What it is |
|---|---|
| `SCRIPT_HANDLERS` | The names the runtime treats as lifecycle hooks. |
| `compileScript`, `buildFactoryBody` | Turn script source into a factory. |
| `registerScriptModule`, `resolveScriptModule`, `createScriptImporter` | The module table a script's `import` resolves through. |
| `setScriptProvider`, `resolveNodeScript` | The no-eval path a published build uses. |
| `attachScriptFactory`, `unwrapScriptNode` | Bind a factory to a node. |
| `getData`, `setData`, `bindDataAccessors`, `canAccessVariable` | The variable access boundary. |
| `NodeVariable` / `NodeVariableType` / `NodeVariableAccess` *(types)* | |
| `ScriptModule` / `ScriptFactory` *(types)* | |

## Input

**Vocabulary:** `KEY_CODES`, `MOUSE_BUTTONS`, `POINTER_AXES`, `GAMEPAD_BUTTONS`, `GAMEPAD_AXES`,
`TOUCH_GESTURES`, `DEVICE_KINDS`, `STATE_FLAGS`, `MAX_GAMEPAD_PLAYERS`, `sourceKey`, `sourceLabel`.
Types: `KeyCode`, `MouseButton`, `PointerAxis`, `GamepadButton`, `GamepadAxis`, `TouchGesture`,
`BindingSource`, `ModifierSource`, `DeviceKind`, `StateFlag`.

**Model:** `ACTION_KINDS`, `ACTION_PHASES`, `COMPOSITE_PARTS`, `PROCESSOR_KINDS`,
`DEFAULT_PRESS_POINT`, `DEFAULT_TOUCH_CONFIG`, `DEFAULT_INPUT_MAP`, `IDLE_STATE`, `idleState`,
`defaultProcessor`, `cloneInputMap`, `isDefaultInputMap`, `parseInputMap`, and the `normalize*`
family (`normalizeSource`, `normalizeModifier`, `normalizeProcessor`, `normalizeBinding`,
`normalizeAction`, `normalizeActionMap`, `normalizeVirtualControl`, `normalizeTouchConfig`).
Types: `ActionKind`, `ActionPhase`, `ActionState`, `CompositePart`, `InputAction`, `InputActionMap`,
`InputBinding`, `InputMap`, `Processor`, `ProcessorKind`, `TouchGestureConfig`, `VirtualControl`.

**Math:** `applyDeadzone1D`, `applyRadialDeadzone`, `applyCurve`, `applyScale`, `applyInvert`,
`normalizeVec2`, `smoothToward`, `runProcessors1D`, `runProcessors2D`, `SmoothingState` *(type)*.

**Gestures and virtual controls:** `createGestureState`, `stepTouchGestures`, `virtualLayoutRect`,
`layoutVirtualControls`, `hitTestVirtual`, `stickVector`, `createVirtualState`,
`stepVirtualControls`, plus their types.

**Runtime:** `Input` (the facade a script uses), `InputSystem`, `DeviceSampler`, `GamepadSampler`,
`createDeviceSnapshot`, `createResolveState`, `resolveFrame`. Types: `ActionListener`,
`RebindFilter`, `Unsubscribe`, `ActionChange`, `DeviceSnapshot`, `GamepadReading`, `PointerReading`,
`ResolveResult`, `ResolveState`.

See [Input (scripting)](../scripting/input.md) and [Input bindings](input-bindings.md).

## Control — intent, locomotion, steering

**Intent:** `INTENT_REQUESTS`, `createIntent`, `clearIntent`, `raiseRequest`, `isRequested`,
`consumeRequest`, `decayRequests`, `forwardFromYaw`, `rightFromYaw`, `moveWorldDirection`,
`setMoveWorld`, `shortestAngle`, `applyPlayerReading`. Types: `ControlIntent`, `IntentRequest`,
`PlayerReading`, `ControlVec2`.

**Locomotion:** `FACING_MODES`, `LOCOMOTION_DEFAULTS`, `locomotionTuning`, `createLocomotionState`,
`stepLocomotion`. Types: `FacingMode`, `LocomotionTuning`, `LocomotionSense`, `LocomotionState`,
`LocomotionOutput`.

**Steering:** `STEERING_DEFAULTS`, `steeringTuning`, `createSteeringState`, `seek`, `flee`,
`arrive`, `pursue`, `followTarget`, `wander`, `separate`, `align`, `cohere`, `avoidObstacles`,
`blendSteering`, `intentFromDesired`. Types: `SteeringTuning`, `SteeringState`, `ProbeHit`,
`FlockNeighbour`.

## AI

**Behaviour machine:** `AI_GOALS`, `BEHAVIOR_SENSES`, `BEHAVIOR_PARAM_TYPES`, `EMPTY_BEHAVIOR`,
`createBehaviorRuntime`, `entryState`, `stateNamed`, `stepBehavior`, `isDefaultBehaviorMachine`,
and the parsers `parseBehaviorMachine` / `parseBehaviorState` / `parseBehaviorTransition` /
`parseBehaviorParameter`. Types: `AiGoal`, `BehaviorMachine`, `BehaviorState`,
`BehaviorTransition`, `BehaviorParameter`, `BehaviorParameterSource`, `BehaviorParameterType`,
`BehaviorRuntime`, `BehaviorSense`, `BehaviorStep`.

**Goals:** `EMPTY_GOAL_GRAPH`, `GoalBrain`, `buildGoalBrain`, `isDefaultGoalGraph`,
`parseGoalGraph`, `parseGoalDefinition`, `parseDesirability`. Types: `GoalGraph`, `GoalDefinition`,
`DesirabilityDefinition`, `GoalContext`.

**Fuzzy:** `FuzzyBrain`, `buildFuzzyModule`, `DEFUZZIFICATIONS`, `FUZZY_SET_SHAPES`,
`EMPTY_FUZZY_MODEL`, `isDefaultFuzzyModel`, and the parsers `parseFuzzyModel` / `parseFuzzyRule` /
`parseFuzzySet` / `parseFuzzyTerm` / `parseFuzzyVariable`. Types: `FuzzyModel`,
`FuzzyVariableDefinition`, `FuzzySetDefinition`, `FuzzyRuleDefinition`, `FuzzyTermNode`,
`FuzzySetShape`, `Defuzzification`.

**Perception:** `Perception`, `PERCEPTION_DEFAULTS`, `perceptionTuning`. Types: `Sighting`,
`PerceptionTuning`, `PerceptionCandidate`, `LineOfSightTest`.

**Navigation:** `AISystem` (+ `AISceneLike`, `NavMeshSource`), `aiStats`, `resetAIStats`,
`AIStats` *(type)*; `CleoNavMesh`, `buildNavMesh`, `parseNavMeshData`, `serializeNavMeshData`,
`polygonsFromData`, `isNavigableUp`, `EMPTY_NAV_MESH_DATA` (+ `NavMeshData`, `NavMeshJson`,
`NavMeshBuildOptions`, `NavRoute`, `OffMeshLink`); baking — `bakeNavMesh`, `NAV_BAKE_DEFAULTS`,
`EMPTY_BAKE_RESULT`, `navBakeSettings`, `simplifyContour`, `triangleSlope`, `walkableSoup`
(+ `NavBakeSettings`, `NavBakeResult`, `TriangleSoup`); sources — `SoupBuilder`,
`clipSoupToVolume`, `heightfieldSoup`, `mergeSoups`, `tessellateSource`, `tessellateSources`
(+ `HeightfieldSource`, `NavPrimitive`, `NavSource`); paths — `createNavPath`, `setNavPath`,
`clearNavPath`, `hasPath`, `currentWaypoint`, `onFinalWaypoint`, `advancePath`, `followPath`,
`insetCorners`, `remainingDistance`, `REPATH_DEFAULTS`, `repathPolicy`, `createRepathState`,
`shouldRepath`, `markRepathed` (+ `NavPath`, `RepathPolicy`, `RepathState`).

Plus `parseRoutes`, `parseLinks`, `parseSize`, `parseBakedVolume`, `isDefaultNavMeshSettings` from
the navmesh node.

See [AI (scripting)](../scripting/ai.md).

## Conditions

`CONDITION_OPS`, `createConditionContext`, `latchKey`, `updateLatch`, `forEachCondition`,
`conditionMet`, `conditionNodeMet`, `gateMet`, `consumeTriggers`, `parseCondition`,
`parseConditionNode`. Types: `Condition`, `ConditionGroup`, `ConditionNode`, `ConditionOp`,
`ConditionContext`.

Shared by the animation state machine and the behaviour machine. The animator re-exports the same
types under their historical `Animation*` names.

## Physics

| Export | What it is |
|---|---|
| `PhysicsSystem` | The world: step, raycast, ground queries, ragdolls, gravity, stats. |
| `Body` (`RigidBody`), `Trigger` | Bodies. `Body` is the exported name. |
| `Shape` | Collider factories: `Box`, `Sphere`, `Capsule`, `Cylinder`, `Plane`, `ConvexHull`, `TriMesh`, `Heightfield`. |
| `PhysicsRaycastHit` / `PhysicsRaycastOptions` *(types)* | |
| `Ragdoll`, `RAGDOLL_DEFAULTS`, `RagdollOptions` *(type)* | |
| `convexHull`, `hullFromPositions`, `HULL_BUDGETS`, `Hull` / `HullQuality` *(types)* | Hull fitting. |
| `physicsStats`, `PhysicsStats` *(type)* | |
| `createMotionRecord`, `sampleMotion`, `planarSplit`, `facingComponents`, `headingAngle`, `signedAngleBetween`, `wrapDegrees`, `motionConfig`, `MOTION_DEFAULTS`, `MotionRecord` / `MotionConfig` *(types)* | The measured-motion machinery behind `planarSpeed` and friends. |

## Animation

| Export | What it is |
|---|---|
| `Animator` | Playback, state machine, blend spaces, events, IK, ragdoll handover. |
| `NODE_BUILTINS`, `NodeBuiltinName` *(type)* | Values a parameter can bind to. |
| `isConditionGroup` | |
| `AnimatedModel`, `Skin` / `Joint` / `Animation` / `AnimationSampler` / `AnimationChannel` *(types)* | |
| State-machine types | `AnimationStateMachine`, `AnimationState`, `AnimationTransition`, `AnimationParameter`, `AnimationParameterType`, `AnimationVariableBinding`, `AnimationEventMarker`, `AnimationCondition`, `AnimationConditionOp`, `AnimationConditionGroup`, `AnimationConditionNode`, `AnimationMapping`. |
| Blend spaces | `fieldWeights`, `rateScaleOf`, `phaseOffsetOf`, `coincidentSamples`, `axisSmoothing`, `axisDeadzone`, `axisWrapSpan`, `weightSmoothing`, `DEFAULT_AXIS_SMOOTHING`, `DEFAULT_WEIGHT_SMOOTHING`, and the types `AnimationField`, `AnimationFieldMode`, `AnimationFieldAxis`, `AnimationFieldSample`, `FieldWeight`. |
| Retargeting | `remapAnimationToSkin`, `buildBoneMapping`, `applyManualMapping`, `mappingReport`, `retargetAnimation`, `describeRetarget`, `humanoidRigOf`, `normalizeBoneName`, `humanoidSlotOf`, plus `AnimationCompatibility`, `HierarchyMismatch`, `BoneMapping`, `BoneMappingEntry`, `BoneMatchKind`. |
| Skeleton | `skeletonTopology`, `isAncestorJoint`, `nearestCommonAncestor`, `SkeletonTopology` *(type)*. |
| Foot IK | `solveTwoBone`, `applyTwoBone`, `ikTuning`, `validateIkRig`, `swingReleaseWeight`, `IK_DEFAULTS`, `DEFAULT_MAX_REACH`, and the types `IkRig`, `IkFootChain`, `IkRigTuning`, `IkRigProblem`, `IkRigValidation`, `TwoBoneSolve`, `TwoBoneResult`. |

## Graphics

| Export | What it is |
|---|---|
| `Renderer`, `RenderSettings` / `QualityPreset` / `ToneMapper` / `SkeletonOverlay` *(types)* | See [Render settings](render-settings.md). |
| `Material`, `TerrainMaterial`, `CustomMaterial` | Materials. |
| `FOLIAGE_DENSITY_UNIT`, `DEFAULT_FOLIAGE_DENSITY`, `migrateFoliageRule`, `foliageRuleKey` | Foliage rules on a terrain material. |
| Material types | `TerrainBaseType`, `TerrainFoliageRule`, `FoliageCollision`, `CustomBaseType`, `CustomRenderMode`, `CustomUniform`, `CustomUniformType`. |
| `customSeedTemplate`, `customSeedUniforms`, `tryCompileCustom`, `assembleCustomFragment`, `setWgslTranslator`, `hasWgslTranslator`, `vulkanUnsupportedReason`, `ShaderDialect` / `WgslTranslator` *(types)* | Custom-shader compilation. |
| `Mesh`, `Model`, `Submesh` *(type)* | |
| `Texture`, `TextureConfig` / `WrapMode` *(types)*, `TextureManager` | |
| `TexturePacker`, `isDerivedTextureId`, `PACKED_ID_PREFIX`, `PackSpec` / `ChannelSource` *(types)* | Channel-packed maps. Engine-owned: never assignable or serializable. |
| `Skybox` | |
| Lights | `DirectionalLight`, `PointLight`, `Spotlight`, `LIGHT_UNIT`, `REFERENCE_ILLUMINANCE`, `DEFAULT_DIRECTIONAL_LUX`, `DEFAULT_LUMENS`, `DEFAULT_RANGE`, `DEFAULT_SOURCE_RADIUS`, `DEFAULT_ANGULAR_RADIUS`, `DEFAULT_SCENE_AMBIENT_LUX`, `MAX_LIGHTS`, `legacyRange`, `distanceAttenuation`, `legacyAmbientFromSceneJson`. |
| Post chain | `DEFAULT_POST_CHAIN`, `resolvePostChain`, `isDefaultChain`, `isBuiltinEffect`, `materialIndexOf`, `PostChainEntry` / `PostEffectId` / `BuiltinEffectId` *(types)*. |
| Sprites | `Sprite`, `gridTileset`, `legacySheetTileset`, `remapLegacyFrame`, `isInlineTilesetId`, `INLINE_TILESET_PREFIX`, `SpriteOptions` / `SpriteSide` *(types)*. |
| Displacement | `MAX_TESS_LEVEL`, `tessSegments`, `tessBudget`, `tessVertsPerTri`, `tessTrisPerTri`, `MeshDisplacer`. |
| Backend | `webgpuAvailableInBrowser`, `WEBGPU_IMPLEMENTED`, `BackendKind` *(type)*, `setGLContext`, `setDevice`, `WebGL2Device`. |
| Profiling | `frameStats`, `currentViewport`, `RenderStats` *(type)*, `gpuProfiler`, `frameHistory`, `Ring`, `RENDER_PASSES`, `TOGGLEABLE_PASSES`, `PassTiming` / `RenderPass` / `FrameSample` *(types)*, `cpuProfiler`. |

## Asset loading

`Loader` (models, animated models, animations, images), `GLTFLoader`, `parseAssimpFiles`,
`convertToGltf2FromFiles`, `readAssimpTextureSlots`, `parseResultTransferables`, `mergeModels`,
`mergeBlocker`. Types: `MergePart`, `TextureLoadReport`, `UnresolvedTexture`, `AssimpParseResult`,
`AssimpTextureSlots`, `ParsedMesh`, `OutputMaterial`, `GltfParseResult`, `GltfMeshDescriptor`,
`GltfMaterialDescriptor`, `GltfImageSource`.

## Audio

`AudioManager`, `Sound`, `Mixer`, `EffectRack`, `BUS_IDS`, `EFFECT_KINDS`, `DISTANCE_MODELS`,
`DEFAULT_SOUND_SETTINGS`, `DEFAULT_SPATIAL_SETTINGS`, `defaultEffect`, `normalizeEffect`,
`normalizeEffects`, `clampSettings`, `parseSoundSettings`, `parseSpatialSettings`, `rackShapeOf`,
`attenuationAt`. Types: `BusId`, `SoundEffect`, `EffectKind`, `SoundSettings`, `SpatialSettings`,
`DistanceModel`, `FilterKind`, `Oversample`.

## Terrain

`Terrain`, `TERRAIN_RELIEF_ENABLED`, and the types `TerrainConfig`, `SculptBrush`, `SculptMode`,
`TerrainLayer`, `PaintBrush`, `TerrainChunk`, `TerrainLodSettings`, `FoliageGenerateResult`.

Foliage: `FoliageLayer`, `crossQuadGeometry`, `MAX_INSTANCES`, `FOLIAGE_DRAW_TRIANGLE_BUDGET`,
`FoliageColliderField`, `DEFAULT_FOLIAGE_COLLIDERS`, and `FoliageKind`, `FoliageParams`,
`FoliageColliderSettings`.

## Tilemaps

`Tilemap`, `DEFAULT_FILL_LIMIT`, `TilemapLayer`, `defaultLayerConfig`, `Tileset`.

Cell maths: `cellToWorld`, `worldToCell`, `cellCorners`, `cellSortY`, `neighbours`,
`neighbourCount`, `normalizeGrid`. Chunks: `CHUNK_SIZE`, `CELL_EMPTY`, `packCell`, `cellTile`,
`cellFlags`, `cellFlipX`, `cellFlipY`, `cellRot90`, `withTile`, `chunkKey`, `chunkCoord`.
Auto-tiling: `autoTileMask`, `resolveAutoTile`, `pickWeightedVariant`, `cellNoise`. Collision:
`greedyMerge`, `SolidBox` *(type)*.

Types: `TileEdit`, `TileOrientation`, `TilemapLayerConfig`, `LayerBounds`, `TilesetConfig`,
`TileMeta`, `TileAnimation`, `TerrainSet`, `VariantSet`, `WangKind`, `GridSpec`, `GridKind`,
`HexOrientation`, `HexOffset`, `TileChunk`.

## Math and utilities

| Export | What it is |
|---|---|
| `Vec` | All of gl-matrix, as a namespace: `Vec.vec3`, `Vec.quat`, `Vec.mat4`, … |
| `MathUtils` | The engine's own maths helpers, as a namespace. |
| `clamp`, `lerp`, `damp`, `dampTime` | The four you will actually reach for. |
| `Raycaster`, `Ray` / `RaycastHit` *(types)* | Screen-to-ray and scene raycasting. |
| `BVH`, `rayTriangleIntersection`, `BVHHit` *(type)* | Exact triangle picking. |
| `Frustum` | |
| `aimFromDirection` | Yaw/pitch from a direction vector. |
| `bytesToBase64`, `base64ToBytes`, `bytesToDataUrl`, `parseBase64DataUri` | |

## See also

[Node types](node-types.md) · [Render settings](render-settings.md) · [Scripting guide](../scripting/README.md)
