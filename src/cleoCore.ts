// The engine API every Cleo program runs on: what a published game carries, and what its scripts reach as
// `import { ... } from 'cleo'`. The full engine (./cleo.ts) is this plus the editor's tools -- the model
// importers (assimp, glTF, FBX), the script compiler and the movie renderer -- which a published game never
// runs and so does not ship. The published player imports this module (`cleo/cleoCore`); the editor, Play in
// window and the tests import ./cleo.ts.

export { VERSION } from "./version";
export { CleoEngine } from "./core/engine";
export type { EngineInitializeOptions } from "./core/engine";
export { Camera } from "./core/camera";
export { Geometry } from "./core/geometry";
export { Scene, sceneDimensionOf } from "./core/scene/scene";
export type { InstantiateOptions, SceneDimension } from "./core/scene/scene";
export { registerTemplates, clearTemplates, getTemplate, templateNames, registeredTemplates } from "./core/scene/templates";
export { mountSpawnWarmup, warmCopyJson, particleCopiesOf, precompileTemplateScripts, SPAWN_WARMUP_HOLDER } from "./core/scene/spawnWarmup";
export type { SpawnWarmup } from "./core/scene/spawnWarmup";
export type { NodeTemplate } from "./core/scene/templates";
export { parseNodeJson } from "./core/scene/nodes/parseNodeJson";
export { cloneNodeJson, collectNodeIds, remapNodeRefs, regenerateNodeIds } from "./core/scene/nodeJson";
export { Node } from "./core/scene/nodes/node";
export type { MotionBlurMode, SocketAttachment } from "./core/scene/nodes/node";
export { isEditorOnlyNode, markEditorOnly, isEditorOwnedNode, markEditorOwned, isEditorOwnedName, EDITOR_NODE_MARKERS } from "./core/scene/editorNodes";
export type { NodeType } from "./core/scene/nodes/nodeType";
export { ModelNode, disposeModelSubtree } from "./core/scene/nodes/modelNode";
// Device entry points. Exported so an embedder — or a test that has to construct a Model, which
// allocates GPU buffers in its constructor — can stand up a context without reaching into src/.
export { setGLContext } from "./graphics/rhi/webgl2/glContext";
export { setDevice } from "./graphics/rhi/deviceHandle";
export { WebGL2Device } from "./graphics/rhi/webgl2/webgl2Device";
export { LodGroupNode } from "./core/scene/nodes/lodGroupNode";
export { CameraRigNode } from "./core/scene/nodes/cameraRigNode";
// The control node family. A ControllerNode possesses a CharacterNode and writes its intent; the
// character turns intent into motion and never learns where it came from.
export { CharacterNode } from "./core/scene/nodes/characterNode";
export { ControllerNode, CONTROL_SOURCES, AIM_SOURCES, BRAIN_KINDS } from "./core/scene/nodes/controllerNode";
export type { Pawn, Possessable } from "./core/scene/nodes/controllerNode";
export { isVehicle } from "./core/scene/nodes/nodeType";
export type { BrainKind } from "./core/scene/nodes/controllerNode";
export type { ControlSource, AimSource, BlackboardValue } from "./core/scene/nodes/controllerNode";
export type { FollowSpace, AimMode } from "./core/scene/nodes/cameraRigNode";
export { ColliderNode, ALL_LAYERS } from "./core/scene/nodes/colliderNode";
export type { ColliderShape } from "./core/scene/nodes/colliderNode";
export { TriggerNode } from "./core/scene/nodes/triggerNode";
/** @deprecated A 2D trigger is a {@link TriggerNode} in a 2D scene; Area 2D nodes load as Trigger nodes. */
export { TriggerNode as Area2DNode } from "./core/scene/nodes/triggerNode";
export { migrateLegacyPhysicsJson, migrateLegacyPhysicsTree, hasLegacyPhysics, isLegacyWrapper, legacyColliderId, legacyTriggerId } from "./core/scene/nodes/physicsLegacy";
export { advanceClip, clipLength, frameDuration, normalizedTime as clipNormalizedTime, stepSpriteMachine, parseSpriteAnimationSet, parseSpriteClip, cloneSpriteAnimationSet, createPlayhead } from "./animation/spriteAnimation";
export type { SpriteAnimationSet, SpriteClip, SpriteFrame, SpriteFrameHitbox, SpriteClipLoop, SpriteStateMachine, SpriteMachineState, SpriteMachineTransition, ClipPlayhead } from "./animation/spriteAnimation";
export {
    BODY2D_MOVEMENTS, LOCOMOTION_2D_DEFAULTS, jumpPhysics, locomotion2DTuning, stepLocomotion2D, tickLocomotion2D,
    integrateGravity2D, createLocomotion2DState, createLocomotion2DEvents, createContacts2D,
} from "./physics2d/locomotion2d";
export type {
    Body2DMovement, Locomotion2DTuning, Locomotion2DState, Locomotion2DEvents, Contacts2D,
} from "./physics2d/locomotion2d";
export { stepBody2D, MAX_SUBSTEP_2D } from "./physics2d/body2d";
export type { Body2DSim, Body2DStepHook } from "./physics2d/body2d";
export { TILE_NONE, TILE_SOLID, TILE_ONE_WAY, TILE_SLOPE } from "./physics2d/types";
export type { RayHit2D } from "./physics2d/collide2d";
export { LightNode } from "./core/scene/nodes/lightNode";
export type { LightType, LightBakeSnapshot } from "./core/scene/nodes/lightNode";
export { LightProbeNode } from "./core/scene/nodes/lightProbeNode";
export { probeBakeStaleness, lightBakeChanges, describeLightChanges } from "./core/scene/probeBakeState";
export type { StaleProbe, StaleLight, LightBakeChange } from "./core/scene/probeBakeState";
export { GiBakeRegistry, newGiBakeId } from "./graphics/render/gi/giBakeRegistry";
export { ExposureVolumeNode, EXPOSURE_OVERRIDE_KEYS, MIN_EXPOSURE_VOLUME_SIZE } from "./core/scene/nodes/exposureVolumeNode";
export type { ExposureOverrides } from "./core/scene/nodes/exposureVolumeNode";
export type { SkinnedClothData } from "./physics/cloth/skinnedClothData";
export { parseSkinnedCloth } from "./physics/cloth/skinnedClothData";
export * from "./particles/curves";
export { NITS_PER_INTERNAL_UNIT, particleLuminanceNits, particleIntensityForNits, formatNits } from "./graphics/particles/particleLighting";
export { SkyboxNode } from "./core/scene/nodes/skyboxNode";
// One-click presets: a table per node / render section, all applied through `applyPreset`.
export { applyPreset, definePresets, type Preset } from "./core/presets";
export { WIND_PRESETS, type WindPreset } from "./core/scene/nodes/windPresets";
export { WEATHER_PRESETS, type WeatherPreset } from "./core/scene/nodes/weatherPresets";
export { SKY_ATMOSPHERE_PRESETS, type SkyAtmospherePreset } from "./core/scene/nodes/skyAtmospherePresets";
export { CAMERA_RIG_PRESETS, type CameraRigPreset, type CameraRigPresetOptions } from "./core/scene/nodes/cameraRigPresets";
export { CHARACTER_PRESETS, type CharacterPreset, type CharacterPresetOptions } from "./core/scene/nodes/characterPresets";
export {
    PERCEPTION_PRESETS, FLOCKING_PRESETS, type PerceptionPreset, type FlockingPreset, type FlockingPresetOptions,
} from "./core/scene/nodes/controllerPresets";
export { SOUND_FALLOFF_PRESETS, type SoundFalloffPreset } from "./core/scene/nodes/soundPresets";
export {
    AUTO_EXPOSURE_PRESETS, LENS_LOOK_PRESETS, DOF_PRESETS,
    type AutoExposurePreset, type LensLookPreset, type DofPreset,
} from "./graphics/renderPresets";
export {
    DIRECTIONAL_LIGHT_PRESETS, POINT_LIGHT_PRESETS, SPOT_LIGHT_PRESETS, AREA_LIGHT_PRESETS, lightPresetsFor,
    spotEquivalentLumens, newLightOptions,
    type LightPreset, type LightPresetOptions,
} from "./graphics/lightPresets";
export { kelvinToRgb } from "./graphics/colorTemperature";
export { PHYSICS_SURFACE_PRESETS, type PhysicsSurfacePreset } from "./physics/surfacePresets";
export { SkyAtmosphereNode, DEFAULT_MOON_LUX } from "./core/scene/nodes/skyAtmosphereNode";
export type { SkyAtmosphereOptions } from "./core/scene/nodes/skyAtmosphereNode";
export { SkyLightNode, DEFAULT_NIGHT_AMBIENT } from "./core/scene/nodes/skyLightNode";
export { WindNode, WIND_DEFAULTS, type WindOptions } from "./core/scene/nodes/windNode";
// The wind as a vector field (Ghost of Tsushima's): one function on the CPU and in chunks/windField.wgsl.
export {
    sampleWindField, sampleSceneWind, packWindSources, windGustAt, windVeerAt,
    createWindSample, WindFieldSnapshot, windFieldClock, advanceGustTravel,
    WIND_REFERENCE_SPEED, MAX_WIND_SOURCES, WIND_SOURCE_FLOATS, WIND_DEFAULT_GUSTINESS, WIND_DEFAULT_VEER,
    type WindSample, type WindFieldParams, type WindFieldSource,
} from "./core/wind/windField";
export { OcclusionVolumeNode, OCCLUSION_VOLUME_CULL_KEYS, defaultOcclusionVolumeCull, type OcclusionVolumeCull } from "./core/scene/nodes/occlusionVolumeNode";
export { OcclusionBuffer } from "./graphics/occlusion/occlusionBuffer";
export { TerrainOccluder } from "./graphics/occlusion/terrainOccluder";
export type { SkyLightOptions } from "./core/scene/nodes/skyLightNode";
export { CameraNode } from "./core/scene/nodes/cameraNode";
export { SoundNode } from "./core/scene/nodes/soundNode";
export type { SoundMode, SoundNodeOptions, LoopMode, WhenFull, SoundPlayOptions } from "./core/scene/nodes/soundNode";
// The audio stack. `AudioManager` is the registry a SoundNode resolves its sample through, and the same
// shape as TextureManager on purpose — the editor's asset reconciler, byte store and packer are written
// against that surface.
export { AudioManager } from "./audio/audioManager";
export { Sound } from "./audio/sound";
export { EffectRack } from "./audio/effectRack";
export { Mixer } from "./audio/buses";
export {
    BUS_IDS, EFFECT_KINDS, DISTANCE_MODELS, DEFAULT_SOUND_SETTINGS, DEFAULT_SPATIAL_SETTINGS,
    defaultEffect, normalizeEffect, normalizeEffects, clampSettings, parseSoundSettings,
    parseSpatialSettings, rackShapeOf, attenuationAt,
} from "./audio/soundSettings";
export type {
    BusId, SoundEffect, EffectKind, SoundSettings, SpatialSettings, DistanceModel, FilterKind, Oversample,
} from "./audio/soundSettings";
export { SpriteNode } from "./core/scene/nodes/spriteNode";
export { AnimatedSpriteNode } from "./core/scene/nodes/animatedSpriteNode";
export type { SpriteFrameSource } from "./core/scene/nodes/animatedSpriteNode";
export { getData, setData, bindDataAccessors, canAccessVariable } from "./core/scene/nodes/nodeVariables";
export { attachScriptFactory, unwrapScriptNode } from "./core/scene/nodes/nodeScripting";
export { isUINodeType } from "./core/scene/nodes/nodeType";
export type { NodeVariable, NodeVariableType, NodeVariableAccess } from "./core/scene/nodes/nodeVariables";

export { Logger } from "./core/logger";
export type { LogEntry, LogMethod, LogOptions } from "./core/logger";
export { TypedEmitter, engineEventBus, asDerived } from "./core/eventBus";
export type { EngineEventMap, SceneChange, ChangeKind, StructureOp, NodePlacement, DirtyAspect, NodeDirty } from "./core/eventBus";
// The cross-asset reference graph. Kind-agnostic on purpose: the editor owns the per-kind readers that
// turn an asset record into edges, and feeds them in through `setEdges`.
export { AssetGraph, assetGraph, assetKey, refKey } from "./core/assets/assetGraph";
export type { AssetRef, AssetKey, AssetEdge, EdgeTarget } from "./core/assets/assetGraph";
// The condition model and evaluator, shared by the animation state machine and the behavior one. The
// animator re-exports the same types under their historical `Animation*` names.
export {
    CONDITION_OPS, createConditionContext, latchKey, updateLatch, forEachCondition, conditionMet,
    conditionNodeMet, gateMet, consumeTriggers, parseCondition, parseConditionNode,
} from "./core/conditions";
export type { Condition, ConditionGroup, ConditionNode, ConditionOp, ConditionContext } from "./core/conditions";
// The control layer: what a driver WANTS (intent) and how a character turns that into motion. Pure and
// DOM-free — a `ControllerNode` fills the intent in from player actions, steering or a script, and a
// `CharacterNode` consumes it, so neither half knows about the other.
export {
    INTENT_REQUESTS, createIntent, clearIntent, raiseRequest, isRequested, consumeRequest, decayRequests,
    moveWorldDirection, setMoveWorld, setMove2D, applyPlayerReading,
} from "./core/control/intent";
export type { ControlIntent, IntentRequest, PlayerReading, Vec2 as ControlVec2 } from "./core/control/intent";
export {
    FACING_MODES, MOVE_DIR_SOURCES, TURN_FRICTION_MAX_ANGLE, LOCOMOTION_DEFAULTS, locomotionTuning, createLocomotionState, stepLocomotion,
} from "./core/control/locomotion";
export type {
    FacingMode, MoveDirSource, LocomotionTuning, LocomotionSense, LocomotionState, LocomotionOutput,
} from "./core/control/locomotion";
export {
    STEERING_DEFAULTS, steeringTuning, createSteeringState, seek, flee, arrive, pursue, followTarget,
    wander, separate, align, cohere, avoidObstacles, blendSteering, intentFromDesired, intentFromDesired2D,
} from "./core/control/steering";
export type {
    SteeringTuning, SteeringState, ProbeHit, FlockNeighbour,
} from "./core/control/steering";
// The behaviour state machine: patrol -> chase -> attack as authored data. Reuses core/conditions.ts,
// which is what keeps it small enough to be worth having.
export {
    AI_GOALS, BEHAVIOR_SENSES, BEHAVIOR_SENSE_TYPES, BEHAVIOR_PARAM_TYPES, EMPTY_BEHAVIOR, createBehaviorRuntime, entryState,
    stateNamed, stepBehavior, parseBehaviorMachine, parseBehaviorState, parseBehaviorTransition,
    parseBehaviorParameter, isDefaultBehaviorMachine,
} from "./core/control/behavior";
export type {
    AiGoal, BehaviorMachine, BehaviorState, BehaviorTransition, BehaviorParameter,
    BehaviorParameterSource, BehaviorParameterType, BehaviorRuntime, BehaviorSense, BehaviorStep,
} from "./core/control/behavior";
export { AISystem } from "./ai/aiSystem";
export type { AISceneLike, NavMeshSource } from "./ai/aiSystem";
export { aiStats, resetAIStats } from "./ai/aiStats";
export type { AIStats } from "./ai/aiStats";
export {
    REPATH_DEFAULTS, advancePath, clearNavPath, createNavPath, createRepathState, currentWaypoint,
    followPath, hasPath, insetCorners, markRepathed, onFinalWaypoint, remainingDistance, repathPolicy,
    setNavPath, shouldRepath, NAV_ACTIONS,
} from "./ai/navPath";
export type { NavPath, NavAction, RepathPolicy, RepathState } from "./ai/navPath";
export {
    NAV_AGENT_2D_DEFAULTS, navAgent2D, followPath2D, simulatePath2D, createFollow2DState, createFollow2DOut,
} from "./ai/navFollow2D";
export type { NavAgent2D, Follow2DState, Follow2DOut, LegResult } from "./ai/navFollow2D";
export { HistoryManager } from "./core/history";
export type { HistoryEntry, HistoryOptions } from "./core/history";
export { Mesh } from "./graphics/mesh";
export { applyUvMapping, uvConfigOf, applyWind, windConfigOf, applyInteraction, interactionConfigOf, type InteractionConfig, applyFoliageSurface, foliageSurfaceOf, foliageSurfaceJson, FOLIAGE_STARTER, isFoliageMaterial, setFoliage, type FoliageSurfaceConfig, emissiveExposureWeightOf, setEmissiveExposureWeight, type WindConfig } from "./graphics/material";
export type { UvConfig, UvProjection, UvSpace } from "./graphics/material";
export { Material, TerrainMaterial, CustomMaterial, WaterMaterial, FOLIAGE_DENSITY_UNIT, DEFAULT_FOLIAGE_DENSITY, FOLIAGE_ORIENTATIONS, migrateFoliageRule, foliageRuleKey, newTerrainSlotId, legacyHeightBlendToRule, setTerrainSurfaceFrom, shallowCloneTerrainMaterial, terrainFoliageRules, allTerrainFoliageRules, type TerrainFoliageScope } from "./graphics/material";
export { DEFAULT_WATER_LOOK, WATER_LOOK_PRESETS, normaliseWaterLook, type WaterLook, type WaterLookPreset } from "./water/waterLook";
export type { TerrainBaseType, TerrainFoliageRule, TerrainMaterialSlot, FoliageCollision, FoliageOrientation, CustomBaseType, CustomRenderMode, CustomUniform, CustomUniformType } from "./graphics/material";
export { customSeedTemplate, customSeedUniforms, tryCompileCustom, assembleCustomFragment,
         setWgslTranslator, hasWgslTranslator, vulkanUnsupportedReason, customWgslHash } from "./graphics/systems/customShaders";
export type { ShaderDialect, WgslTranslator } from "./graphics/systems/customShaders";
export { webgpuAvailableInBrowser, WEBGPU_IMPLEMENTED } from "./graphics/rhi/backendSelect";
export type { BackendKind } from "./graphics/rhi/device";
export { Renderer, RENDER_2D_DEFAULTS, RENDER_3D_DEFAULTS } from "./graphics/renderer";
export type { SkeletonOverlay, RenderSettings, QualityPreset, ToneMapper, Pipeline2D } from "./graphics/renderer";
export { Skybox } from "./graphics/skybox";
export { Texture } from "./graphics/texture";
// The editor authors these: a texture asset's settings compile down to a TextureConfig.
export type { TextureConfig, WrapMode } from "./graphics/texture";
// Merging an importer's per-material sub-meshes into one mesh with one submesh per material.
export { mergeModels, mergeBlocker } from "./graphics/modelMerge";
export type { MergePart } from "./graphics/modelMerge";
export { extractSubmesh, withoutSubmesh, compactRanges, drawRanges } from "./graphics/modelSplit";
export type { CompactedRanges } from "./graphics/modelSplit";
// The action-mapping input system. `inputSources` is the device vocabulary a binding names, `actionMap`
// the serializable model plus its tolerant readers, and the rest the pure math the resolver runs on —
// all DOM-free, so the editor's panel and the unit suite can import them without a canvas.
export {
    KEY_CODES, MOUSE_BUTTONS, POINTER_AXES, GAMEPAD_BUTTONS, GAMEPAD_AXES, TOUCH_GESTURES, DEVICE_KINDS,
    STATE_FLAGS, MAX_GAMEPAD_PLAYERS, sourceKey, sourceLabel,
} from "./input/inputSources";
export type {
    KeyCode, MouseButton, PointerAxis, GamepadButton, GamepadAxis, TouchGesture, BindingSource,
    ModifierSource, DeviceKind, StateFlag,
} from "./input/inputSources";
export {
    ACTION_KINDS, ACTION_PHASES, COMPOSITE_PARTS, PROCESSOR_KINDS, DEFAULT_PRESS_POINT,
    DEFAULT_TOUCH_CONFIG, DEFAULT_INPUT_MAP, IDLE_STATE, idleState, defaultProcessor, cloneInputMap,
    isDefaultInputMap, normalizeSource, normalizeModifier, normalizeProcessor, normalizeBinding,
    normalizeAction, normalizeActionMap, normalizeVirtualControl, normalizeTouchConfig, parseInputMap,
} from "./input/actionMap";
export type {
    ActionKind, ActionPhase, ActionState, CompositePart, InputAction, InputActionMap, InputBinding,
    InputMap, Processor, ProcessorKind, TouchGestureConfig, VirtualControl,
} from "./input/actionMap";
export {
    applyDeadzone1D, applyRadialDeadzone, applyScale, applyInvert, runProcessors1D, runProcessors2D,
} from "./input/processors";
export type { SmoothingState } from "./input/processors";
export { createGestureState, stepTouchGestures } from "./input/gestures";
export type { GestureOutput, GestureState, PointerSample, TrackedPointer } from "./input/gestures";
export {
    virtualLayoutRect, layoutVirtualControls, hitTestVirtual, stickVector, createVirtualState,
    stepVirtualControls,
} from "./input/virtualControls";
export type { VirtualLayout, VirtualReading, VirtualState, VirtualTouch } from "./input/virtualControls";
export { createDeviceSnapshot, createResolveState, resolveFrame } from "./input/resolveActions";
// The runtime halves: DeviceSampler/GamepadSampler touch the DOM and the Gamepad API, InputSystem wires
// them to the resolver, and `Input` is the facade a user script imports.
export { DeviceSampler } from "./input/deviceSampler";
export { isTextEntryEvent, isTextEntryTarget } from "./input/textEntry";
export { GamepadSampler } from "./input/gamepadSampler";
export { InputSystem } from "./input/inputSystem";
export type { ActionListener, RebindFilter, Unsubscribe } from "./input/inputSystem";
export { Input } from "./input/inputApi";
export type { MouseApi, MousePickOptions, MousePhysicsPickOptions } from "./input/mouseApi";
export type {
    ActionChange, DeviceSnapshot, GamepadReading, PointerReading, ResolveResult, ResolveState,
} from "./input/resolveActions";
export { TextureManager } from "./graphics/systems/textureManager";
// Channel packing: metallic/roughness/occlusion (and specular/reflectivity) source maps combined into
// one texture before the shaders sample them. `isDerivedTextureId` identifies the results, which are
// engine-owned — never assignable, listable or serializable.
export { TexturePacker, isDerivedTextureId, PACKED_ID_PREFIX } from "./graphics/systems/texturePacker";
export type { PackSpec, ChannelSource } from "./graphics/systems/texturePacker";
export { RigidBody as Body, Trigger } from "./physics/body";
export type { TriggerOptions, TriggerContact } from "./physics/body";
export type { TriggerOverlap } from "./physics/triggerOverlaps";
export { Ragdoll, RAGDOLL_DEFAULTS } from "./physics/ragdoll";
export type { RagdollOptions } from "./physics/ragdoll";
export {
    autoHumanoidProfile, effectiveRagdollProfile, parseRagdollProfile, ragdollLayout, defaultJoint,
    findBoneJoint, ragdollPartPose, RAGDOLL_PROFILE_DEFAULTS,
} from "./physics/ragdollProfile";
export type {
    RagdollProfile, RagdollPart, RagdollJoint, RagdollShape, RagdollJointType, RagdollLayout, RagdollLayoutPart,
} from "./physics/ragdollProfile";
export { Model, serializeGeometry } from "./graphics/model";
export type { Submesh } from "./graphics/model";
export { AnimatedModel } from "./animation/animatedModel";
export type { Skin, SkinSocket, Joint, Animation, AnimationSampler, AnimationChannel } from "./animation/animatedModel";
export { socketNames, socketJoint, socketModelMatrix, socketOffsetMatrix, IMPLICIT_SOCKETS } from "./animation/sockets";
export { resolveSocketOwner } from "./core/scene/socketFollow";
export { remapAnimationToSkin, buildBoneMapping, applyManualMapping, mappingReport, retargetAnimation, retargetSegments, describeRetarget, humanoidRigOf } from "./animation/animationRetarget";
export { skeletonTopology, isAncestorJoint, nearestCommonAncestor } from "./animation/skeletonTopology";
export type { SkeletonTopology } from "./animation/skeletonTopology";
export { solveTwoBone, applyTwoBone, ikTuning, validateIkRig, IK_DEFAULTS, DEFAULT_MAX_REACH } from "./animation/ik";
export type { IkRig, IkFootChain, IkRigTuning, IkRigProblem, IkRigValidation, TwoBoneSolve, TwoBoneResult } from "./animation/ik";
export type { AnimationCompatibility, HierarchyMismatch, BoneMapping, BoneMappingEntry, BoneMatchKind, RetargetPlan } from "./animation/animationRetarget";
export { normalizeBoneName, humanoidSlotOf } from "./animation/boneNames";
export { mirrorBoneName } from "./animation/boneNames";
// Non-destructive clip edits. Exported in full because three separate consumers need them: the editor's
// resolve, the published player's resolve, and the clip editor's Bake command — and the individual ops
// are what the unit tests pin.
export {
    applyClipEdits, mirrorClip, bakeInPlace, applyPoseOffset, trimClip, timeScaleClip,
    mirrorPairs, mirrorAxisOf, rootMotionNodeOf, rootParentRotation, clipDuration, resetClipEditWarnings,
} from "./animation/clipEdit";
export type { ClipEdit, ClipEditContext, PoseBone, MirrorAxis } from "./animation/clipEdit";
export { swingReleaseWeight, stepFootLock, footLockWeight, FOOT_LOCK_MAX_TWIST, FOOT_LOCK_CURVES } from "./animation/ik";
export { footLockKey, footLockAt, normalizeFootLockSpans, shrinkFootLockSpans, detectFootLockWindows, humanoidFeet } from "./animation/footLockWindows";
export type { FootLockWindows, FootLockDetectOptions } from "./animation/footLockWindows";
export type { FootLockStep, FootLockCurve } from "./animation/ik";
export { Animator, isConditionGroup, NODE_BUILTINS } from "./animation/animator";
export { FORK_DEPTH, forksFromAnywhere, isForkIn, pathsFrom, resolveIn as resolveMachineTarget, staticEnd as forkEnd } from "./animation/machineForks";
export type { MachinePath, MachineView } from "./animation/machineForks";
export type { NodeBuiltinName } from "./animation/animator";
export { parseEventActions, runEventActions, resolveTarget, drawnWorldPosition } from "./animation/eventActions";
export type { EventAction, EventActionBinding } from "./animation/eventActions";
export {
    createMotionRecord, sampleMotion, motionConfig, MOTION_DEFAULTS,
} from "./physics/motion";
export type { MotionRecord, MotionConfig } from "./physics/motion";
export {
    fieldWeights, rateScaleOf, phaseOffsetOf, coincidentSamples, poseSampleKey,
    axisSmoothing, axisDeadzone, axisWrapSpan, weightSmoothing,
    DEFAULT_AXIS_SMOOTHING, DEFAULT_WEIGHT_SMOOTHING,
} from "./animation/animationField";
export type {
    AnimationField,
    AnimationFieldMode,
    AnimationFieldAxis,
    AnimationFieldSample,
    FieldWeight,
} from "./animation/animationField";
export type {
    AnimationMapping,
    AnimationStateMachine,
    AnimationState,
    AnimationStateTrigger,
    AnimationTriggerInfo,
    AnimationTransition,
    AnimationCondition,
    AnimationConditionOp,
    AnimationConditionGroup,
    AnimationConditionNode,
    AnimationParameter,
    AnimationParameterType,
    AnimationVariableBinding,
    AnimationEventMarker,
    AnimationLayer,
    AnimationStateGroup,
    AnimationFork,
    AnimationReroute,
    AnimationReroutes,
    AnimationSlotDef,
    AnimationBlendMode,
    AnimationPose,
    AnimationPoseBone,
    AnimationHandIk,
    AnimationActionOptions,
    AnimationActionHandle,
} from "./animation/animator";
export { Sprite, gridTileset, legacySheetTileset, remapLegacyFrame, isInlineTilesetId, INLINE_TILESET_PREFIX } from "./graphics/sprite";
export type { SpriteOptions, SpriteSide, SpriteBlend } from "./graphics/sprite";
export { DirectionalLight, PointLight, Spotlight, AreaLight, AREA_LIGHT_SHAPES, DEFAULT_AREA_LUMENS, DEFAULT_AREA_WIDTH,
         DEFAULT_AREA_HEIGHT, MIN_AREA_LIGHT_SIZE, LIGHT_UNIT, REFERENCE_ILLUMINANCE, DEFAULT_DIRECTIONAL_LUX,
         DEFAULT_LUMENS, DEFAULT_RANGE, DEFAULT_SOURCE_RADIUS, DEFAULT_ANGULAR_RADIUS,
         DEFAULT_SCENE_AMBIENT_LUX, MAX_LIGHTS, legacyRange,
         distanceAttenuation, legacyAmbientFromSceneJson, exposureCurveStops } from "./graphics/lighting";
export type { ExposureCurveKey, AreaLightShape, AreaLightProperties } from "./graphics/lighting";
export { Shape } from "./physics/shape";
export { PhysicsSystem } from "./physics/physicsSystem";
export type { PhysicsRaycastHit, PhysicsRaycastOptions, JointSpec } from "./physics/physicsSystem";
export { PhysicsBody, BodyVec3, BodyQuat } from "./physics/physicsBody";
export type { PhysicsBodyOptions } from "./physics/physicsBody";
export type { OverlapHit, OverlapOptions } from "./physics/overlap";
export {
    LAYER, LAYER_COUNT, LAYER_BITS, BUILT_IN_LAYERS, DEFAULT_LAYER_NAMES, LAYER_NAME_MAX,
    DEFAULT_CAMERA_BLOCKED_BY, DEFAULT_CAMERA_SEE_THROUGH,
    layerBit, singleLayerOf, isAllLayers, storedMask, layerLabel, normalizeLayerNames, layerByName, layerLabelsOf,
    layersCollide,
} from "./physics/collisionLayers";
export type { CameraProbeLayers } from "./physics/cameraRayFilter";
export { migrateCameraLayersTree, legacyFoliageCollisionLayer } from "./core/scene/nodes/cameraLayersLegacy";
export type { CameraLayersMigration } from "./core/scene/nodes/cameraLayersLegacy";
export type { ColliderPart, PartShape, ConvexHull, ColliderGeometry, ColliderDesc, ShapeDesc, JointHandle, PhysicsBackendKind } from "./physics/pal/types";
export { PHYSICS_BACKENDS, DEFAULT_PHYSICS_BACKEND, FALLBACK_PHYSICS_BACKEND, resolvePhysicsBackendRequest } from "./physics/pal/backendSelect";
export type { PhysicsBackendRequest } from "./physics/pal/backendSelect";
export { describePhysicsCapabilities } from "./physics/pal/capabilities";
export type { PhysicsCapabilities } from "./physics/pal/capabilities";
export { physicsStats } from "./physics/physicsStats";
export type { PhysicsStats } from "./physics/physicsStats";
export { sceneStats, sceneStatsDetail } from "./core/scene/sceneStats";
export { engineStats, frameAccount, FrameAccount } from "./core/engineStats";
export type { EngineFrame, FrameSummary } from "./core/engineStats";
export type { SceneStats } from "./core/scene/sceneStats";
export { frameStats, currentViewport } from "./graphics/renderStats";
export type { RenderStats } from "./graphics/renderStats";
export { shaderStats } from "./graphics/shaderStats";
export {
    shaderOptimizerStats, MaterialSync, DrawSortKeys, ProgramCompileQueue, parseRecipes, serializeRecipe,
} from "./graphics/shaderOptimizer";
export type { ShaderOptimizerStats, PipelineRecipe } from "./graphics/shaderOptimizer";
// Background shader builds as they happen, for the editor's progress popup.
export { shaderActivity } from "./graphics/shaderActivity";
export type { ShaderActivity, ShaderBuild } from "./graphics/shaderActivity";
// A published game's shader library: which program needs which module, and the library the player installs.
export { programModules } from "./graphics/render/programs";
export { installShaderLibrary, shadersAreLibraryHandles } from "./graphics/shaderLibrary";
// The optional features' registry: a published game's player installs the ones it was built with.
export {
    installFeature, installFeatures, restrictFeatures, setAbsentFeatureNames, isFeatureInstalled, featureApiNames,
    type FeatureModule, type FeatureRegistrar,
} from "./core/features/registry";
export type { ShaderLibrary, ShaderLibraryEntry, ShaderModuleData } from "./graphics/shaderLibrary";
// The optional features a project can leave out of its games (Project ▸ Features), as data.
export { FEATURES, FEATURE_GROUPS, FEATURE_PRESETS, featureById, enabledFeatures, dependentsOf, featureOfNodeType, presetMatching } from "./modules/catalog";
export { EXPERIMENTAL_NOTE, isExperimentalFeature, experimentalFeatureOfNodeType, experimentalNoteOf } from "./modules/catalog";
export type { FeatureDef, FeatureGroup, FeaturePreset } from "./modules/catalog";
export { physicalFor, particleSimProgram, usesParallax } from "./graphics/programVariants";
export type { ShaderBuildRecord } from "./graphics/shaderStats";
export { gpuProfiler, frameHistory, Ring, RENDER_PASSES, TOGGLEABLE_PASSES } from "./graphics/gpuProfiler";
export type { PassTiming, RenderPass, FrameSample } from "./graphics/gpuProfiler";
export { DEFAULT_POST_CHAIN, resolvePostChain, isDefaultChain, isBuiltinEffect, materialIndexOf }
    from "./graphics/renderGraph/chain";
export type { PostChainEntry, PostEffectId, BuiltinEffectId } from "./graphics/renderGraph/chain";
export { cpuProfiler } from "./graphics/cpuProfiler";
export { convexHull, hullFromPositions, HULL_BUDGETS } from "./physics/convexHull";
export type { Hull, HullQuality } from "./physics/convexHull";
export { brushFalloffWeight, brushFalloffExponent } from "./terrain/brushFalloff";
// The landscape layer stack: blend rules and their CPU evaluation, the stack itself, paint masks, the
// sculpt tools and heightmap I/O. See terrain/terrainLayers.ts for the model.
export {
    MAX_TERRAIN_SURFACES, MAX_PAINT_LAYERS, defaultBlendRule, parseBlendRule, cloneBlendRule, rangeCoverage,
    slopeDegreesFromNormalY, surfaceAlpha, compositeWeights, ruleNoise,
} from "./terrain/terrainLayers";
export type { TerrainBlendRule, TerrainRuleRange, TerrainNoiseRule, TerrainFlatSurface, TerrainSurfaceData } from "./terrain/terrainLayers";
export { TERRAIN_LAYER_TEXTURE_SIZES, DEFAULT_TERRAIN_LAYER_TEXTURE_SIZE } from "./terrain/terrainLayerSizes";
// Where a plant's collider sits on it: shared with the navmesh bake (AI), so it stays with the engine.
export { foliageColliderPose } from "./terrain/foliageColliderPose";
export { Tileset, MAX_TILESET_OVERDRIVE } from "./graphics/tilemap/tileset";
export type { TilesetConfig, TileMeta, TileAnimation, TerrainSet, VariantSet, WangKind } from "./graphics/tilemap/tileset";
export { Raycaster } from "./core/raycaster";
export type { Ray, RaycastHit } from "./core/raycaster";
export { BVH } from "./core/bvh";
export type { BVHHit } from "./core/bvh";
export { Frustum } from "./core/frustum";
export { bytesToBase64, base64ToBytes, bytesToDataUrl, parseBase64DataUri } from "./core/base64";
export { registerScriptModule, resolveScriptModule, createScriptImporter, compileScript, scriptCompileCount, clearScriptCompileCache, buildFactoryBody, setScriptProvider, resolveNodeScript, SCRIPT_HANDLERS } from "./core/scripting/scriptRuntime";
// User script modules: one script importing another ('@/Shared/Math', './Util').
export {
    normalizeScriptSpecifier, listScriptImports, compileScriptModule, createModuleImporter, setScriptModuleSources,
    addScriptModuleSources, setScriptModuleProvider, resetScriptModules, knownScriptModules,
} from "./core/scripting/scriptRuntime";
export type { ScriptCompileOptions, ScriptModuleFactory } from "./core/scripting/scriptRuntime";
export type { ScriptModule, ScriptFactory } from "./core/scripting/scriptRuntime";
// Where a script runs as the browser and the debugger see it (cleo-script:///Player/Hero.ts), and script errors
// that keep that location.
export { scriptSourceUrl, inlineScriptUrl, isScriptUrl, moduleIdOfScriptUrl, scriptLocationOf, scriptLocationLabel } from "./core/scripting/scriptUrls";
export type { ScriptSourceLocation } from "./core/scripting/scriptUrls";
export { logScriptError } from "./core/scripting/scriptErrors";
// The native attribute types (docs/scripting/attribute-types.md): each is a type for a script's field and a token
// of the same name for an engine declaration. Colours and vectors, names the inspector lists, and -- through
// the engine classes themselves (Material, Texture, Sound, Tileset, every Node) -- assets and nodes.
export {
    SOUNDS_GROUP, ownedSoundsGroup,
    Color, ColorAlpha, Vec2, Vec3, Vec4, CollisionLayer, CollisionMask,
    ClipName, SoundName, SocketName, TemplateName, NodeName, TriggerName, SpriteClipName, ActionName, SceneName, LayerName, ParamName,
} from "./core/scripting/fieldTypes";
export type { ProjectTriggers, ProjectActions } from "./core/scripting/fieldTypes";
export {
    NAME_KINDS, ASSET_FIELD_KINDS, propertyToken, Choice, ListOf, Integer, typeOfToken, typeFromAnnotation, literalUnionOf,
    propertyTypeLabel, defaultOf, isTextType, samePropertyType, upgradePropertyType, registerClassType,
} from "./core/properties/types";
export type { PropertyType, PropertyToken, PropertyTokenLike, NameKind, AssetFieldKind, AnnotationContext } from "./core/properties/types";
export {
    isAssetRef, isNodePathRef, assetRef, nodePathRef, registerAssetResolver, resolveAsset, assetRefOf, rememberAssetRef,
    registerAssetTable, clearAssetTable, registerAssetParser, holdsFieldRef, storedValueFits,
} from "./core/properties/fieldRefs";
export type { AssetFieldRef, NodePathRef, AssetTable, AssetResolver } from "./core/properties/fieldRefs";
export { relativeNodePath, nodeAtRelativePath } from "./core/save/nodePaths";
import "./core/properties/assetKinds";
// What the script compile calls for decorators, and what reads them back. The decorators themselves (@child,
// @onAction, @attribute, @save, …) are 'cleo/decorators' (./decorators.ts), registered at the end of this file.
export { applyScriptDecorators, scriptMembersOf, membersOfNode, SCRIPT_METADATA } from "./core/scripting/decorators";
export type { ScriptMember, LoweredMember } from "./core/scripting/decorators";
export { GameEvents } from "./core/scripting/scriptEvents";
// The event system (src/core/events, docs/scripting/events.md): channels on a hub, sync / async / deferred, events at nodes.
export {
    Events, EventChannel, CleoEvent, Emitter, Subject, ValueSubject, ChannelEmitter,
    DEFAULT_CHANNEL, ANIMATION_CHANNEL, ENGINE_CHANNEL, getChannel, allChannels, splitEventName, flushAllChannels,
    resetScriptChannels, hasScriptListeners, sendEvent, receiveRemoteEvent, setEventTransportResolver, setEventErrorReporter,
    addTargetListener, removeTargetListener, hasTargetListener, dispatchAt,
} from "./core/events";
export type {
    EventListenerFn, EventWhere, ListenOptions, EventPhase, ChannelOptions, DispatchOptions, PostOptions, NextOptions,
    SubjectObserver, SendOptions, EventTransport, EventTransportResolver, TransportResult, RemoteEventTarget, EventDestination, EventRoute,
} from "./core/events";
export { observableOf } from "./core/scene/nodes/nodeScripting";
export type { AnimationEventInfo, AnimationStateEventInfo } from "./animation/animator";
export { lowerScriptDecorators, decoratorSiteAt, type DecoratorSite } from "./core/scripting/scriptDecoratorLowering";
export { Game, Net, setGameHost, setMovieRender, type MovieRenderInfo } from "./core/game";
export { NodeNet } from "./core/net/sceneNet";
export type { NetCallOptions, NetCallTarget, NetEventTarget, SceneNet } from "./core/net/sceneNet";
export { TimeDilation, type DilateOptions } from "./core/timeDilation";
export { showLoadingOverlay, nextFrame, whenFramesSmooth } from "./core/loadingOverlay";
export type { LoadingOverlay, LoadingOverlayOptions } from "./core/loadingOverlay";
export type { GameHost, LoadProgressListener, LoadSceneOptions } from "./core/game";
// Saving and loading game state: `SaveGame` for scripts; the store and runtime-scene parse for hosts.
export * from "./core/save";
export type { NodeSaveInfo } from "./core/scene/nodes/node";
export type { SceneSaveState } from "./core/scene/scene";
export * as Vec from "gl-matrix";
export * as MathUtils from "./core/math";
// The most used of MathUtils by name as well. Each was once exported from the module that first needed it
// (intent, processors, motion, windField, autotile, bvh); they all live in core/math.ts now. The particle
// curve and gradient names come through `export * from "./particles/curves"` above.
export {
    clamp, lerp, damp, dampTime, eulerFromQuatDeg, decomposeTRS, aimFromDirection,
    wrapDegrees, headingAngle, signedAngleBetween, planarSplit, facingComponents, forwardFromYaw, rightFromYaw,
    shortestAngle, applyCurve, normalizeVec2, smoothToward, windPerlin, windPerlinGrad, cellNoise,
    rayTriangleIntersection,
} from "./core/math";
// The cinematic sequencer is an optional feature (src/modules/sequencer). A sequence's keys are core/math.ts's
// keyed curves and its paths are Spline3s, which stay here.
export {
    evaluateKeyedNumber, evaluateKeyedVector, evaluateKeyedStep, keyedCurveWidth, rampWeight, hermite, Spline3,
    type Vec3Tuple, type KeyInterp, type TimedKey, type KeyedCurve,
} from "./core/math";
export { renderNow, setRenderClock } from "./graphics/render/renderClock";
export {
    AudioRecorder, AudioMixdown, audioRecorder, buildAudioSchedule, mixAudioLog, keyValueAt,
    type AudioLog, type AudioLogSound, type AudioOp, type AudioSchedule, type VoicePlan, type VoicePiece,
    type AudioKey, type MixOptions,
} from "./audio/movieAudio";

// What a user script's `import { ... } from 'cleo'` resolves to in a published game: this module's own
// namespace. ./cleo.ts registers the full engine over it. Must stay the LAST statement: the self-import only
// works once every re-export above has been evaluated.
import * as CleoCoreAPI from "./cleoCore";
import { registerScriptModule as registerCore } from "./core/scripting/scriptRuntime";
registerCore('cleo', CleoCoreAPI);
// `import { attribute, onAction } from 'cleo/decorators'`: the script decorators, kept out of the barrel. Here
// rather than in cleo.ts so the published player has them too; the full engine adds nothing to them.
import * as CleoDecoratorsAPI from "./decorators";
// `@pick` is gone: a field's type says what it names. An old script importing it fails as it loads, saying so.
const CleoDecoratorsModule: Record<string, unknown> = { ...CleoDecoratorsAPI };
Object.defineProperty(CleoDecoratorsModule, 'pick', {
    enumerable: false, configurable: true,
    get() { throw new Error("'@pick' is gone: a field's type says what it names now -- `clip: ClipName`, `cue: SoundName`, `next: NodeName` (docs/scripting/attribute-types.md)"); },
});
registerCore('cleo/decorators', CleoDecoratorsModule);
