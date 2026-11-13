export { VERSION } from "./version";
export { CleoEngine } from "./core/engine";
export type { EngineInitializeOptions } from "./core/engine";
export { Camera } from "./core/camera";
export { Geometry } from "./core/geometry";
export { Scene, sceneDimensionOf } from "./core/scene/scene";
export type { InstantiateOptions, SceneDimension } from "./core/scene/scene";
export { registerTemplates, clearTemplates, getTemplate, templateNames } from "./core/scene/templates";
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
export type { Pawn } from "./core/scene/nodes/controllerNode";
export type { BrainKind } from "./core/scene/nodes/controllerNode";
export type { ControlSource, AimSource, BlackboardValue } from "./core/scene/nodes/controllerNode";
export type { FollowSpace, AimMode } from "./core/scene/nodes/cameraRigNode";
export { LandscapeNode } from "./core/scene/nodes/landscapeNode";
export { TilemapNode } from "./core/scene/nodes/tilemapNode";
export { Camera2DNode } from "./core/scene/nodes/camera2DNode";
export { Room2DNode } from "./core/scene/nodes/room2DNode";
export { ParallaxLayerNode } from "./core/scene/nodes/parallaxLayerNode";
export { CharacterBody2DNode } from "./core/scene/nodes/characterBody2DNode";
export { Body2DNode } from "./core/scene/nodes/body2DNode";
export type { Body2DKind } from "./core/scene/nodes/body2DNode";
export { Area2DNode } from "./core/scene/nodes/area2DNode";
export { World2D } from "./physics2d/world2d";
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
export { GIVolumeNode, GI_RAY_COUNTS, GI_CAPTURE_RESOLUTIONS, MIN_GI_PROBES_PER_AXIS, MAX_GI_PROBES_PER_AXIS, MAX_GI_PROBE_INSET, DEFAULT_NEW_GI_PROBE_INSET } from "./core/scene/nodes/giVolumeNode";
export type { GiRayCount, GiCaptureResolution, GiVolumeOptions } from "./core/scene/nodes/giVolumeNode";
export { GiBakeRegistry, newGiBakeId } from "./graphics/render/gi/giBakeRegistry";
export { encodeGiBake, decodeGiBake, GiBakeFormatError, GI_BAKE_VERSION, GI_BAKE_MIN_VERSION } from "./graphics/render/gi/giBakeFormat";
export { FluidVolumeNode, FLUID_BRICK, OCCUPANCY_MARGIN, occupancyFromVolume, floatToHalf, floatsToHalves } from "./core/scene/nodes/fluidVolumeNode";
export { ExposureVolumeNode, EXPOSURE_OVERRIDE_KEYS, MIN_EXPOSURE_VOLUME_SIZE } from "./core/scene/nodes/exposureVolumeNode";
export type { ExposureOverrides } from "./core/scene/nodes/exposureVolumeNode";
export { VolumetricFogNode, VOLUMETRIC_FOG_PRESETS, MIN_FOG_VOLUME_SIZE } from "./core/scene/nodes/volumetricFogNode";
export type { VolumetricFogOptions, VolumetricFogPreset } from "./core/scene/nodes/volumetricFogNode";
export { DecalNode, decalLocalToUV, radialDecalWeight, radialDecalT, DECAL_RADIAL_CURVES, decalFlipbookFrame, decalFlipbookFrom } from "./core/scene/nodes/decalNode";
export { ParticleSystemNode } from "./core/scene/nodes/particleSystemNode";
export type { ParticleSystemNodeOptions, ParticleCullingMode } from "./core/scene/nodes/particleSystemNode";
export { ForceFieldNode, MAX_FORCE_FIELDS } from "./core/scene/nodes/forceFieldNode";
export { ClothNode, CLOTH_DEFAULTS, jointOf as clothJointOf } from "./core/scene/nodes/clothNode";
export type { ClothOptions, ClothPinEdge } from "./core/scene/nodes/clothNode";
export { XpbdCloth, CLOTH_SOLVER_DEFAULTS, gridIndices, windGust } from "./physics/cloth/xpbdCloth";
export type { ClothCapsule, ClothSettings } from "./physics/cloth/xpbdCloth";
export { weightsFromCloth, clothFromWeights, settingsOf as clothSettingsOf, twinsOf as clothTwinsOf, neighboursOf as clothNeighboursOf, brushDab as clothBrushDab, fillPiece as clothFillPiece, fillRange as clothFillRange, DEFAULT_CLOTH_SETTINGS } from "./physics/cloth/clothPaint";
export type { ClothSettings as SkinnedClothSettings, ClothBrushMode, ClothDab } from "./physics/cloth/clothPaint";
export type { SkinnedClothData } from "./physics/cloth/skinnedClothData";
export { parseSkinnedCloth } from "./physics/cloth/skinnedClothData";
export { WaterVolumeNode, WATER_RIPPLE_SLOTS } from "./core/scene/nodes/waterVolumeNode";
export type { WaterVolumeOptions } from "./core/scene/nodes/waterVolumeNode";
export type { ForceFieldOptions, ForceFieldKind, ForceFieldShape } from "./core/scene/nodes/forceFieldNode";
export * from "./particles/particleSystemAsset";
export { selectParticleLod, particleLodDistance, particleLodFactors, PARTICLE_LOD_HYSTERESIS, type ParticleLodState } from "./particles/particleLod";
export * from "./particles/particleModules";
export * from "./particles/curves";
export { NITS_PER_INTERNAL_UNIT, particleLuminanceNits, particleIntensityForNits, formatNits } from "./graphics/particles/particleLighting";
export { packEmitter, stepUniforms, SIM as PARTICLE_SIM_FLAGS, DRAW as PARTICLE_DRAW_FLAGS } from "./particles/particlePack";
export type { PackedEmitter } from "./particles/particlePack";
export { EmitterRuntime, ParticleSystemRuntime, particleTextureLayout, PARTICLE_TEXTURE_WIDTH, resolveSubEmitters } from "./particles/particleRuntime";
export type { SimStep, EmitterState, SubEmitterLink } from "./particles/particleRuntime";
export { builtinParticleMesh, particleMeshFromNodeJson, parseParticleMesh, PARTICLE_MESH_TRIANGLE_WARNING } from "./particles/particleMesh";
export type { ParticleMeshData, ParticleMeshKind } from "./particles/particleMesh";
export { customCodeKey, composeCustomSim, validatedCustomCode } from "./particles/particleCustomCode";
export type { CompiledCustomCode } from "./particles/particleCustomCode";
export { setParticleGlslTranslator, hasParticleGlslTranslator, compileParticleCustomCode } from "./graphics/particles/particleCustom";
export { MAX_SORTED_PARTICLES } from "./graphics/particles/particleRenderer";
export type { DecalOptions, DecalAffects, DecalRadialPattern, DecalRadialCurve, DecalRadialShape, DecalReceivers, DecalPattern, DecalColor, DecalFlipbook, DecalFlipbookFrame } from "./core/scene/nodes/decalNode";
export { SkyboxNode } from "./core/scene/nodes/skyboxNode";
export { VolumetricCloudsNode } from "./core/scene/nodes/volumetricCloudsNode";
export type { VolumetricCloudsOptions } from "./core/scene/nodes/volumetricCloudsNode";
export { VOLUMETRIC_CLOUDS_PRESETS } from "./core/scene/nodes/volumetricCloudsPresets";
export type { VolumetricCloudsPreset } from "./core/scene/nodes/volumetricCloudsPresets";
// One-click presets: a table per node / render section, all applied through `applyPreset`.
export { applyPreset, definePresets, type Preset } from "./core/presets";
export { WIND_PRESETS, type WindPreset } from "./core/scene/nodes/windPresets";
export { WEATHER_PRESETS, type WeatherPreset } from "./core/scene/nodes/weatherPresets";
export { WATER_VOLUME_PRESETS, type WaterVolumePreset } from "./core/scene/nodes/waterVolumePresets";
export { FORCE_FIELD_PRESETS, type ForceFieldPreset } from "./core/scene/nodes/forceFieldPresets";
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
export {
    WeatherNode, WEATHER_DEFAULTS, MIN_WEATHER_VOLUME_SIZE, PRECIPITATION_KINDS, parsePrecipitationSprite,
    type WeatherOptions, type PrecipitationKind, type PrecipitationSprite,
} from "./core/scene/nodes/weatherNode";
// Falling rain and snow: the particle system a WeatherNode's precipitation falls with, and its own sprites.
export { PrecipitationRig } from "./core/scene/precipitationRig";
export {
    precipitationSystem, PRECIPITATION_DEFAULTS, builtinSpriteOf,
    type FallingKind, type PrecipitationStyle, type PrecipitationEnvironment,
} from "./particles/precipitation";
export {
    BUILTIN_RAIN_SPRITE, BUILTIN_SNOW_SPRITE, BUILTIN_SPRITE_PREFIX, isBuiltinTextureId, builtinSpriteSheet,
} from "./particles/precipitationSprites";
export { OcclusionVolumeNode, OCCLUSION_VOLUME_CULL_KEYS, defaultOcclusionVolumeCull, type OcclusionVolumeCull } from "./core/scene/nodes/occlusionVolumeNode";
export { OcclusionBuffer } from "./graphics/occlusion/occlusionBuffer";
export { TerrainOccluder } from "./graphics/occlusion/terrainOccluder";
export type { SkyLightOptions } from "./core/scene/nodes/skyLightNode";
export { CameraNode } from "./core/scene/nodes/cameraNode";
export { SoundNode } from "./core/scene/nodes/soundNode";
export type { SoundMode, SoundNodeOptions, LoopMode } from "./core/scene/nodes/soundNode";
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
// UI nodes. Every class must be exported individually: a script's base type is resolved by CLASS NAME,
// and the editor's script library matches the same names.
export { UINode } from "./core/scene/nodes/ui/uiNode";
export { UIRootNode } from "./core/scene/nodes/ui/uiRoot";
export { UIPanelNode, UIStackNode, UISpacerNode } from "./core/scene/nodes/ui/uiContainers";
export { UITextNode, UIImageNode } from "./core/scene/nodes/ui/uiContent";
export { UIButtonNode, UIProgressBarNode, UISliderNode, UIToggleNode, UITextInputNode } from "./core/scene/nodes/ui/uiWidgets";
export { isUINodeType } from "./core/scene/nodes/nodeType";
export type { UIImageFit, UIFillDirection, UITextAlign, UITextVAlign, UISizing, UIColor } from "./core/scene/nodes/ui/uiNode";
export {
    setRect as uiSetRect, solveRect as uiSolveRect, rootScale as uiRootScale,
    projectToScreen as uiProjectToScreen, worldUIScale, intersectRect as uiIntersectRect,
    rectOffscreen as uiRectOffscreen, stackLayout as uiStackLayout,
} from "./core/uiLayout";
export type { UIRect, UIScaleMode, UISpace, StackJustify, StackItem, ScreenProjection } from "./core/uiLayout";
export type { NodeVariable, NodeVariableType, NodeVariableAccess } from "./core/scene/nodes/nodeVariables";

export { Logger } from "./core/logger";
export type { LogEntry, LogMethod, LogOptions } from "./core/logger";
export { TypedEmitter, engineEventBus, asDerived } from "./core/eventBus";
export type { EngineEventMap, SceneChange, ChangeKind, StructureOp, NodePlacement } from "./core/eventBus";
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
    FACING_MODES, LOCOMOTION_DEFAULTS, locomotionTuning, createLocomotionState, stepLocomotion,
} from "./core/control/locomotion";
export type {
    FacingMode, LocomotionTuning, LocomotionSense, LocomotionState, LocomotionOutput,
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
// Navigation. Yuka supplies the funnel and the region merge; everything that touches the engine is
// ours, and no Yuka TYPE is re-exported here on purpose -- `cleoTypes.ts` feeds dist's declarations to
// Monaco alongside a hand-listed set of `?raw` dependency types, and a dependency it has not been told
// about degrades to `any` silently, because skipLibCheck swallows it.
export {
    NavMeshNode, parseRoutes, parseLinks, parseSize, parseBakedVolume, isDefaultNavMeshSettings,
} from "./core/scene/nodes/navMeshNode";
export {
    SoupBuilder, carveSoup, clipSoupToVolume, foliageNavObstacles, heightfieldSoup, mergeSoups, navObstacleFor,
    navSourceForShape,
    tessellateSource, tessellateSources,
} from "./ai/navSources";
export type {
    HeightfieldSource, NavCarveOptions, NavObstacle, NavPrimitive, NavShapeDescription, NavSource,
} from "./ai/navSources";
export {
    DEFUZZIFICATIONS, EMPTY_FUZZY_MODEL, FUZZY_SET_SHAPES, FuzzyBrain, buildFuzzyModule,
    isDefaultFuzzyModel, parseFuzzyModel, parseFuzzyRule, parseFuzzySet, parseFuzzyTerm,
    parseFuzzyVariable,
} from "./ai/fuzzy";
export type {
    Defuzzification, FuzzyModel, FuzzyRuleDefinition, FuzzySetDefinition, FuzzySetShape,
    FuzzyTermNode, FuzzyVariableDefinition,
} from "./ai/fuzzy";
export {
    EMPTY_GOAL_GRAPH, GoalBrain, buildGoalBrain, isDefaultGoalGraph, parseDesirability,
    parseGoalDefinition, parseGoalGraph,
} from "./ai/goals";
export type {
    DesirabilityDefinition, GoalContext, GoalDefinition, GoalGraph,
} from "./ai/goals";
export { PERCEPTION_DEFAULTS, Perception, perceptionTuning } from "./ai/perception";
export type {
    LineOfSightTest, PerceptionCandidate, PerceptionTuning, Sighting,
} from "./ai/perception";
export { AISystem } from "./ai/aiSystem";
export type { AISceneLike, NavMeshSource } from "./ai/aiSystem";
export { aiStats, resetAIStats } from "./ai/aiStats";
export type { AIStats } from "./ai/aiStats";
export {
    CleoNavMesh, EMPTY_NAV_MESH_DATA, buildNavMesh, buildNavMeshShared, clearSharedNavMeshes, isNavigableUp,
    navBuildStats, navMeshDataKey, parseNavMeshData, polygonsFromData, serializeNavMeshData,
} from "./ai/navMesh";
export type { NavMeshData, NavMeshJson, NavMeshBuildOptions, NavRoute, OffMeshLink } from "./ai/navMesh";
export {
    NAV_BAKE_DEFAULTS, EMPTY_BAKE_RESULT, bakeNavMesh, navBakeSettings, simplifyContour,
    triangleSlope, walkableSoup,
} from "./ai/navBake";
export type { NavBakeInput, NavBakeSettings, NavBakeResult, TriangleSoup } from "./ai/navBake";
export {
    REPATH_DEFAULTS, advancePath, clearNavPath, createNavPath, createRepathState, currentWaypoint,
    followPath, hasPath, insetCorners, markRepathed, onFinalWaypoint, remainingDistance, repathPolicy,
    setNavPath, shouldRepath,
} from "./ai/navPath";
export type { NavPath, RepathPolicy, RepathState } from "./ai/navPath";
export { HistoryManager } from "./core/history";
export type { HistoryEntry, HistoryOptions } from "./core/history";
export { Mesh } from "./graphics/mesh";
export { applyUvMapping, uvConfigOf, applyWind, windConfigOf, applyInteraction, interactionConfigOf, type InteractionConfig, applyFoliageSurface, foliageSurfaceOf, foliageSurfaceJson, FOLIAGE_STARTER, isFoliageMaterial, setFoliage, type FoliageSurfaceConfig, emissiveExposureWeightOf, setEmissiveExposureWeight, type WindConfig } from "./graphics/material";
export type { UvConfig, UvProjection, UvSpace } from "./graphics/material";
export { Material, TerrainMaterial, CustomMaterial, FOLIAGE_DENSITY_UNIT, DEFAULT_FOLIAGE_DENSITY, FOLIAGE_ORIENTATIONS, migrateFoliageRule, foliageRuleKey, newTerrainSlotId, legacyHeightBlendToRule, setTerrainSurfaceFrom, shallowCloneTerrainMaterial, terrainFoliageRules, allTerrainFoliageRules, type TerrainFoliageScope } from "./graphics/material";
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
export { Loader } from "./graphics/loader";
// Merging an importer's per-material sub-meshes into one mesh with one submesh per material.
export { mergeModels, mergeBlocker } from "./graphics/modelMerge";
export type { MergePart } from "./graphics/modelMerge";
export { extractSubmesh, withoutSubmesh, compactRanges, drawRanges } from "./graphics/modelSplit";
export type { CompactedRanges } from "./graphics/modelSplit";
export type { TextureLoadReport, UnresolvedTexture } from "./graphics/loader";
// The pure (no DOM, no GL) half of model import, so the editor can run it inside a Web Worker.
// Pair with Loader.assembleAssimpModels, which does the GL half on the main thread.
export { parseAssimpFiles, parseResultTransferables, convertToGltf2FromFiles, readAssimpTextureSlots } from "./graphics/utils/assimpLoader";
export type { AssimpParseResult, AssimpTextureSlots, ParsedMesh, OutputMaterial } from "./graphics/utils/assimpLoader";
export { readFbxTextures, isBinaryFbx, fbxBaseName } from "./graphics/utils/fbxEmbedded";
export type { FbxTextureInfo, FbxEmbeddedImage, FbxMaterialTextures } from "./graphics/utils/fbxEmbedded";
export { GLTFLoader } from "./graphics/utils/gltfLoader";
export type { GltfParseResult, GltfMeshDescriptor, GltfMaterialDescriptor, GltfImageSource } from "./graphics/utils/gltfLoader";
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
export { swingReleaseWeight } from "./animation/ik";
export { Animator, isConditionGroup, NODE_BUILTINS } from "./animation/animator";
export type { NodeBuiltinName } from "./animation/animator";
export { parseEventActions, runEventActions, resolveTarget, drawnWorldPosition } from "./animation/eventActions";
export type { EventAction, EventActionBinding } from "./animation/eventActions";
export {
    createMotionRecord, sampleMotion, motionConfig, MOTION_DEFAULTS,
} from "./physics/motion";
export type { MotionRecord, MotionConfig } from "./physics/motion";
export {
    fieldWeights, rateScaleOf, phaseOffsetOf, coincidentSamples,
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
    AnimationSlotDef,
    AnimationBlendMode,
    AnimationPose,
    AnimationPoseBone,
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
export type { ColliderPart, PartShape, ConvexHull, ColliderGeometry, ColliderDesc, ShapeDesc, JointHandle, PhysicsBackendKind } from "./physics/pal/types";
export { PHYSICS_BACKENDS, DEFAULT_PHYSICS_BACKEND, resolvePhysicsBackendRequest } from "./physics/pal/backendSelect";
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
export { createProgramUsage, usageFromSceneJson, usageFromRenderSettings, castsShadows, programsFor, PROGRAM_CLASS } from "./graphics/programUsage";
export type { ProgramUsage } from "./graphics/programUsage";
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
export { Terrain } from "./terrain/terrain";
// Terrain layer relief is off; the editor hides its authoring controls behind the same flag so
// nothing is exposed that does nothing. See the constant for why it is a flag and not a deletion.
export { TERRAIN_RELIEF_ENABLED } from "./terrain/terrain";
export { brushFalloffWeight, brushFalloffExponent } from "./terrain/brushFalloff";
// The landscape layer stack: blend rules and their CPU evaluation, the stack itself, paint masks, the
// sculpt tools and heightmap I/O. See terrain/terrainLayers.ts for the model.
export {
    MAX_TERRAIN_SURFACES, MAX_PAINT_LAYERS, defaultBlendRule, parseBlendRule, cloneBlendRule, rangeCoverage,
    slopeDegreesFromNormalY, surfaceAlpha, compositeWeights, ruleNoise,
} from "./terrain/terrainLayers";
export type { TerrainBlendRule, TerrainRuleRange, TerrainNoiseRule, TerrainFlatSurface, TerrainSurfaceData } from "./terrain/terrainLayers";
export { TerrainLayerStack, defaultMaskResolution, materialSlots } from "./terrain/terrainLayerStack";
export type { TerrainPaintLayer, TerrainBaseLayer, TerrainLayerWeights, StackLayersSnapshot } from "./terrain/terrainLayerStack";
export { MaskGrid } from "./terrain/terrainMasks";
export type { MaskRegion, MaskPatch, MaskPaint } from "./terrain/terrainMasks";
export { TERRAIN_LAYER_TEXTURE_SIZES, DEFAULT_TERRAIN_LAYER_TEXTURE_SIZE } from "./terrain/terrainSurfaceArrays";
export { applySculpt, brushWeight, curveWeight, readRegion, writeRegion, unionRegion, terraceHeight } from "./terrain/sculpt";
export type { SculptTool, FalloffCurve, BrushShape, BrushSpec, SculptParams, GridRegion, HeightGrid, StampAlpha } from "./terrain/sculpt";
export { decodeHeightmap, decodePng, decodeRaw16, encodePng16, encodeRaw16, heightsFromImage, imageFromHeights, sampleHeight } from "./terrain/heightmapIO";
export type { HeightImage, HeightImportOptions } from "./terrain/heightmapIO";
export { decodePngChannels, weightsToOverAlphas, weightPlanesToAlphaPlanes, readWorldManifest, weightPlanesFromImages, resamplePlane } from "./terrain/splatmapIO";
export type { DecodedPng, WorldManifest, WorldManifestLayer } from "./terrain/splatmapIO";
export type { TerrainConfig, SculptBrush, SculptMode, TerrainLayer, PaintBrush, TerrainChunk, TerrainLodSettings, FoliageGenerateResult } from "./terrain/terrain";
export { FoliageLayer, crossQuadGeometry, MAX_INSTANCES, FOLIAGE_DRAW_TRIANGLE_BUDGET, foliageEffectiveCull, foliageLodBands, foliageDensityScale, FOLIAGE_DENSITY_STEPS } from "./terrain/foliage";
export type { FoliageKind, FoliageParams } from "./terrain/foliage";
export { FoliageInteraction, gatherFoliageInteractors, MAX_INTERACT_STAMPS, INTERACT_RANGE, type FoliageInteractor } from "./graphics/foliageInteraction";
export { bakeOctahedralImpostor, rgbaSampler, impostorSphere } from "./terrain/octahedralBake";
export type { OctahedralBakePart, OctahedralBakeOptions, OctahedralBakeResult } from "./terrain/octahedralBake";
export { parseOctahedralInfo, OCTA_DEFAULT_FRAMES } from "./terrain/octahedralImpostor";
export type { OctahedralImpostorInfo } from "./terrain/octahedralImpostor";
export { FoliageColliderField, DEFAULT_FOLIAGE_COLLIDERS, foliageColliderPose } from "./terrain/foliageColliders";
export type { FoliageColliderSettings } from "./terrain/foliageColliders";
export { Tilemap, DEFAULT_FILL_LIMIT } from "./graphics/tilemap/tilemap";
export type { EntitySort } from "./graphics/tilemap/tilemap";
export type { TileEdit, TileOrientation } from "./graphics/tilemap/tilemap";
export { TilemapLayer, defaultLayerConfig } from "./graphics/tilemap/tilemapLayer";
export type { TilemapLayerConfig, LayerBounds } from "./graphics/tilemap/tilemapLayer";
export { Tileset, MAX_TILESET_OVERDRIVE } from "./graphics/tilemap/tileset";
export type { TilesetConfig, TileMeta, TileAnimation, TerrainSet, VariantSet, WangKind } from "./graphics/tilemap/tileset";
export {
    cellToWorld, worldToCell, cellCorners, cellSortY, neighbours, neighbourCount, normalizeGrid,
} from "./graphics/tilemap/cellMath";
export type { GridSpec, GridKind, HexOrientation, HexOffset } from "./graphics/tilemap/cellMath";
export {
    CHUNK_SIZE, CELL_EMPTY, packCell, cellTile, cellFlags, cellFlipX, cellFlipY, cellRot90, withTile, chunkKey, chunkCoord,
} from "./graphics/tilemap/chunk";
export type { TileChunk } from "./graphics/tilemap/chunk";
export { autoTileMask, resolveAutoTile, pickWeightedVariant } from "./graphics/tilemap/autotile";
export { greedyMerge } from "./graphics/tilemap/tilemapCollision";
export type { SolidBox } from "./graphics/tilemap/tilemapCollision";
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
// Typed name fields (clip/sound/socket/template/child): plain strings the inspector offers a picker for.
export { SOUNDS_GROUP, ownedSoundsGroup } from "./core/scripting/fieldTypes";
export type { ClipName, SoundName, SocketName, TemplateName, NodeName, TriggerName, ProjectTriggers, SpriteClipName } from "./core/scripting/fieldTypes";
export { Game, setGameHost, setMovieRender, type MovieRenderInfo } from "./core/game";
export { TimeDilation, type DilateOptions } from "./core/timeDilation";
export { showLoadingOverlay, nextFrame, whenFramesSmooth } from "./core/loadingOverlay";
export type { LoadingOverlay, LoadingOverlayOptions } from "./core/loadingOverlay";
export type { GameHost, LoadProgressListener, LoadSceneOptions } from "./core/game";
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
// The cinematic sequencer: a SequenceNode plays a sequence (tracks of timed sections) against the scene.
export {
    SequenceNode, resolveNodePath, sequenceGlobals, type SequencePlayOptions, type SequenceEndReason,
} from "./core/scene/nodes/sequenceNode";
export { SequencePlayer, type SequencePlayerHost, type SequenceEventListener, type SequencePose } from "./sequencer/sequencePlayer";
export { parseSequence, emptySequence, parseSequenceCurve } from "./sequencer/parse";
// A sequence's keys are core/math.ts's keyed curves and its paths are Spline3s.
export {
    evaluateKeyedNumber, evaluateKeyedVector, evaluateKeyedStep, keyedCurveWidth, rampWeight, hermite, Spline3,
    type Vec3Tuple, type KeyInterp, type TimedKey, type KeyedCurve,
} from "./core/math";
export { compilePropertyPath, isTransformPath, captureVisibility, type PropertyAccessor } from "./sequencer/propertyPath";
export { keyableProperties, sameKeyValue, type KeyableProperty } from "./sequencer/keyable";
export { SEQUENCE_VERSION, FOLIAGE_CHANNELS } from "./sequencer/types";
export { registerSequencePresets, sequencePresetsFor, presetFields, blendPresetValue } from "./sequencer/presetRegistry";
export type {
    SequenceData, SequenceSlot, SequenceTrack, SequenceTrackType, SequenceKey, SequenceCurve,
    SectionBase, PathSection, PathTrack, PathLook, CameraCutSection, CameraCutTrack, PropertySection,
    PropertyTrack, PropertyValueType, EventKey, EventTrack, SequenceMarker,
    PresetSection, PresetTrack, FoliageSection, FoliageTrack, FoliageChannel,
    ScriptSection, ScriptTrack, SequenceScriptContext, AnimationSection, AnimationTrack, AudioSection, AudioTrack,
    SpawnSection, SpawnTrack, PossessSection, PossessTrack,
} from "./sequencer/types";
// Rendering a sequence to video, offline (sequencer/movie/).
export {
    renderMovie, type MovieEngine, type MovieRenderOptions, type MovieFrame, type MovieSink, type MovieProgress,
    type MovieResult, type MovieEndReason, type MovieRunControls,
} from "./sequencer/movie/renderMovie";
export { beginMovieEngine, type MovieEngineHandle, type MovieEngineOptions } from "./sequencer/movie/movieEngine";
export { movieRenderSettings, type MovieQuality } from "./sequencer/movie/movieSettings";
export {
    frameRateOf, framesPerSecond, frameStart, frameTimestampUs, frameDurationUs, sampleTime, sampleJitter,
    shutterFromAngle, frameCountFor, type FrameRate, type SampleSettings,
} from "./sequencer/movie/movieTiming";
export { renderNow, setRenderClock } from "./graphics/render/renderClock";
export {
    AudioRecorder, AudioMixdown, audioRecorder, buildAudioSchedule, mixAudioLog, keyValueAt,
    type AudioLog, type AudioLogSound, type AudioOp, type AudioSchedule, type VoicePlan, type VoicePiece,
    type AudioKey, type MixOptions,
} from "./audio/movieAudio";
import { sequenceGlobals as installSequenceGlobals } from "./core/scene/nodes/sequenceNode";
import { CleoEngine as SequenceEngine } from "./core/engine";
import { Game as SequenceGame } from "./core/game";
// Property tracks aimed at 'renderer' or 'game' resolve here: the node module sits below both in the import graph.
installSequenceGlobals.renderer = () => SequenceEngine.instance?.renderer ?? null;
installSequenceGlobals.game = () => SequenceGame;

// What a user script's `import { ... } from 'cleo'` resolves to: the barrel's own namespace. Must stay
// the LAST statement — the self-import only works once every re-export above has been evaluated.
import * as CleoAPI from "./cleo";
import { registerScriptModule as register } from "./core/scripting/scriptRuntime";
register('cleo', CleoAPI);
