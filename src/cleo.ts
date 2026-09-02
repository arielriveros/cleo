export { VERSION } from "./version";
export { CleoEngine } from "./core/engine";
export { Camera } from "./core/camera";
export { Geometry } from "./core/geometry";
export { Scene } from "./core/scene/scene";
export type { InstantiateOptions } from "./core/scene/scene";
export { registerTemplates, clearTemplates, getTemplate, templateNames } from "./core/scene/templates";
export type { NodeTemplate } from "./core/scene/templates";
export { parseNodeJson } from "./core/scene/nodes/parseNodeJson";
export { cloneNodeJson, collectNodeIds, remapNodeRefs, regenerateNodeIds } from "./core/scene/nodeJson";
export { Node } from "./core/scene/nodes/node";
export type { MotionBlurMode } from "./core/scene/nodes/node";
export type { NodeType } from "./core/scene/nodes/nodeType";
export { ModelNode, disposeModelSubtree } from "./core/scene/nodes/modelNode";
// Device entry points. Exported so an embedder — or a test that has to construct a Model, which
// allocates GPU buffers in its constructor — can stand up a context without reaching into src/.
export { setGLContext } from "./graphics/glContext";
export { setDevice } from "./graphics/rhi/deviceHandle";
export { WebGL2Device } from "./graphics/rhi/webgl2/webgl2Device";
export { LodGroupNode } from "./core/scene/nodes/lodGroupNode";
export { CameraRigNode } from "./core/scene/nodes/cameraRigNode";
export type { FollowSpace, AimMode } from "./core/scene/nodes/cameraRigNode";
export { LandscapeNode } from "./core/scene/nodes/landscapeNode";
export { TilemapNode } from "./core/scene/nodes/tilemapNode";
export { LightNode } from "./core/scene/nodes/lightNode";
export { LightProbeNode } from "./core/scene/nodes/lightProbeNode";
export { SkyboxNode } from "./core/scene/nodes/skyboxNode";
export { VolumetricCloudsNode } from "./core/scene/nodes/volumetricCloudsNode";
export type { VolumetricCloudsOptions } from "./core/scene/nodes/volumetricCloudsNode";
export { SkyAtmosphereNode } from "./core/scene/nodes/skyAtmosphereNode";
export type { SkyAtmosphereOptions } from "./core/scene/nodes/skyAtmosphereNode";
export { SkyLightNode } from "./core/scene/nodes/skyLightNode";
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
export { TypedEmitter, engineEventBus } from "./core/eventBus";
export type { EngineEventMap, SceneChange, ChangeKind, StructureOp, NodePlacement } from "./core/eventBus";
export { HistoryManager } from "./core/history";
export type { HistoryEntry, HistoryOptions } from "./core/history";
export { Mesh } from "./graphics/mesh";
export { Material, TerrainMaterial, CustomMaterial, FOLIAGE_DENSITY_UNIT, DEFAULT_FOLIAGE_DENSITY, migrateFoliageRule, foliageRuleKey } from "./graphics/material";
export type { TerrainBaseType, TerrainFoliageRule, FoliageCollision, CustomBaseType, CustomRenderMode, CustomUniform, CustomUniformType } from "./graphics/material";
export { customSeedTemplate, customSeedUniforms, tryCompileCustom, assembleCustomFragment,
         setWgslTranslator, hasWgslTranslator, vulkanUnsupportedReason } from "./graphics/systems/customShaders";
export type { ShaderDialect, WgslTranslator } from "./graphics/systems/customShaders";
export { webgpuAvailableInBrowser, WEBGPU_IMPLEMENTED } from "./graphics/rhi/backendSelect";
export type { BackendKind } from "./graphics/rhi/device";
export { Renderer } from "./graphics/renderer";
export type { SkeletonOverlay, RenderSettings, QualityPreset, ToneMapper } from "./graphics/renderer";
export { Skybox } from "./graphics/skybox";
export { Texture } from "./graphics/texture";
// The editor authors these: a texture asset's settings compile down to a TextureConfig.
export type { TextureConfig, WrapMode } from "./graphics/texture";
export { Loader } from "./graphics/loader";
// Merging an importer's per-material sub-meshes into one mesh with one submesh per material.
export { mergeModels, mergeBlocker } from "./graphics/modelMerge";
export type { MergePart } from "./graphics/modelMerge";
export type { TextureLoadReport, UnresolvedTexture } from "./graphics/loader";
// The pure (no DOM, no GL) half of model import, so the editor can run it inside a Web Worker.
// Pair with Loader.assembleAssimpModels, which does the GL half on the main thread.
export { parseAssimpFiles, parseResultTransferables, convertToGltf2FromFiles, readAssimpTextureSlots } from "./graphics/utils/assimpLoader";
export { MAX_TESS_LEVEL, tessSegments, tessBudget, tessVertsPerTri, tessTrisPerTri } from "./graphics/systems/meshDisplace";
export { MeshDisplacer } from "./graphics/systems/meshDisplacer";
export type { AssimpParseResult, AssimpTextureSlots, ParsedMesh, OutputMaterial } from "./graphics/utils/assimpLoader";
export { GLTFLoader } from "./graphics/utils/gltfLoader";
export type { GltfParseResult, GltfMeshDescriptor, GltfMaterialDescriptor, GltfImageSource } from "./graphics/utils/gltfLoader";
export { InputManager } from "./input/inputManager";
export { TextureManager } from "./graphics/systems/textureManager";
// Channel packing: metallic/roughness/occlusion (and specular/reflectivity) source maps combined into
// one texture before the shaders sample them. `isDerivedTextureId` identifies the results, which are
// engine-owned — never assignable, listable or serializable.
export { TexturePacker, isDerivedTextureId, PACKED_ID_PREFIX } from "./graphics/systems/texturePacker";
export type { PackSpec, ChannelSource } from "./graphics/systems/texturePacker";
export { RigidBody as Body, Trigger } from "./physics/body";
export { Ragdoll, RAGDOLL_DEFAULTS } from "./physics/ragdoll";
export type { RagdollOptions } from "./physics/ragdoll";
export { Model } from "./graphics/model";
export type { Submesh } from "./graphics/model";
export { AnimatedModel } from "./graphics/animatedModel";
export type { Skin, Joint, Animation, AnimationSampler, AnimationChannel } from "./graphics/animatedModel";
export { remapAnimationToSkin, buildBoneMapping, applyManualMapping, mappingReport, retargetAnimation, describeRetarget, humanoidRigOf } from "./graphics/animationRetarget";
export { skeletonTopology, isAncestorJoint, nearestCommonAncestor } from "./graphics/skeletonTopology";
export type { SkeletonTopology } from "./graphics/skeletonTopology";
export { solveTwoBone, applyTwoBone, ikTuning, validateIkRig, IK_DEFAULTS, DEFAULT_MAX_REACH } from "./graphics/ik";
export type { IkRig, IkFootChain, IkRigTuning, IkRigProblem, IkRigValidation, TwoBoneSolve, TwoBoneResult } from "./graphics/ik";
export type { AnimationCompatibility, HierarchyMismatch, BoneMapping, BoneMappingEntry, BoneMatchKind } from "./graphics/animationRetarget";
export { normalizeBoneName, humanoidSlotOf } from "./graphics/boneNames";
export { swingReleaseWeight } from "./graphics/ik";
export { Animator, isConditionGroup, NODE_BUILTINS } from "./graphics/animator";
export type { NodeBuiltinName } from "./graphics/animator";
export {
    createMotionRecord, sampleMotion, planarSplit, facingComponents, headingAngle, signedAngleBetween, wrapDegrees,
    motionConfig, MOTION_DEFAULTS,
} from "./physics/motion";
export type { MotionRecord, MotionConfig } from "./physics/motion";
export {
    fieldWeights, rateScaleOf, phaseOffsetOf, coincidentSamples,
    axisSmoothing, axisDeadzone, axisWrapSpan, weightSmoothing,
    DEFAULT_AXIS_SMOOTHING, DEFAULT_WEIGHT_SMOOTHING,
} from "./graphics/animationField";
export type {
    AnimationField,
    AnimationFieldMode,
    AnimationFieldAxis,
    AnimationFieldSample,
    FieldWeight,
} from "./graphics/animationField";
export type {
    AnimationMapping,
    AnimationStateMachine,
    AnimationState,
    AnimationTransition,
    AnimationCondition,
    AnimationConditionOp,
    AnimationConditionGroup,
    AnimationConditionNode,
    AnimationParameter,
    AnimationParameterType,
    AnimationVariableBinding,
    AnimationEventMarker,
} from "./graphics/animator";
export { Sprite, gridTileset, legacySheetTileset, remapLegacyFrame, isInlineTilesetId, INLINE_TILESET_PREFIX } from "./graphics/sprite";
export type { SpriteOptions, SpriteSide } from "./graphics/sprite";
export { DirectionalLight, PointLight, Spotlight, LIGHT_UNIT, REFERENCE_ILLUMINANCE, DEFAULT_DIRECTIONAL_LUX,
         DEFAULT_LUMENS, DEFAULT_RANGE, DEFAULT_SOURCE_RADIUS, DEFAULT_ANGULAR_RADIUS,
         DEFAULT_SCENE_AMBIENT_LUX, MAX_LIGHTS, legacyRange,
         distanceAttenuation, legacyAmbientFromSceneJson } from "./graphics/lighting";
export { Shape } from "./physics/shape";
export { PhysicsSystem } from "./physics/physicsSystem";
export type { PhysicsRaycastHit, PhysicsRaycastOptions } from "./physics/physicsSystem";
export { physicsStats } from "./physics/physicsStats";
export type { PhysicsStats } from "./physics/physicsStats";
export { sceneStats, sceneStatsDetail } from "./core/scene/sceneStats";
export type { SceneStats } from "./core/scene/sceneStats";
export { frameStats, currentViewport } from "./graphics/renderStats";
export type { RenderStats } from "./graphics/renderStats";
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
export type { TerrainConfig, SculptBrush, SculptMode, TerrainLayer, PaintBrush, TerrainChunk, TerrainLodSettings, FoliageGenerateResult } from "./terrain/terrain";
export { FoliageLayer, crossQuadGeometry, MAX_INSTANCES, FOLIAGE_DRAW_TRIANGLE_BUDGET } from "./terrain/foliage";
export type { FoliageKind, FoliageParams } from "./terrain/foliage";
export { FoliageColliderField, DEFAULT_FOLIAGE_COLLIDERS } from "./terrain/foliageColliders";
export type { FoliageColliderSettings } from "./terrain/foliageColliders";
export { Tilemap, DEFAULT_FILL_LIMIT } from "./graphics/tilemap/tilemap";
export type { TileEdit, TileOrientation } from "./graphics/tilemap/tilemap";
export { TilemapLayer, defaultLayerConfig } from "./graphics/tilemap/tilemapLayer";
export type { TilemapLayerConfig, LayerBounds } from "./graphics/tilemap/tilemapLayer";
export { Tileset } from "./graphics/tilemap/tileset";
export type { TilesetConfig, TileMeta, TileAnimation, TerrainSet, VariantSet, WangKind } from "./graphics/tilemap/tileset";
export {
    cellToWorld, worldToCell, cellCorners, cellSortY, neighbours, neighbourCount, normalizeGrid,
} from "./graphics/tilemap/cellMath";
export type { GridSpec, GridKind, HexOrientation, HexOffset } from "./graphics/tilemap/cellMath";
export {
    CHUNK_SIZE, CELL_EMPTY, packCell, cellTile, cellFlags, cellFlipX, cellFlipY, cellRot90, withTile, chunkKey, chunkCoord,
} from "./graphics/tilemap/chunk";
export type { TileChunk } from "./graphics/tilemap/chunk";
export { autoTileMask, resolveAutoTile, pickWeightedVariant, cellNoise } from "./graphics/tilemap/autotile";
export { greedyMerge } from "./graphics/tilemap/tilemapCollision";
export type { SolidBox } from "./graphics/tilemap/tilemapCollision";
export { Raycaster } from "./core/raycaster";
export type { Ray, RaycastHit } from "./core/raycaster";
export { BVH, rayTriangleIntersection } from "./core/bvh";
export type { BVHHit } from "./core/bvh";
export { Frustum } from "./core/frustum";
export { bytesToBase64, base64ToBytes, bytesToDataUrl, parseBase64DataUri } from "./core/base64";
export { registerScriptModule, resolveScriptModule, createScriptImporter, compileScript, buildFactoryBody, setScriptProvider, resolveNodeScript, SCRIPT_HANDLERS } from "./core/scripting/scriptRuntime";
export type { ScriptModule, ScriptFactory } from "./core/scripting/scriptRuntime";
export { Game, setGameHost } from "./core/game";
export type { GameHost } from "./core/game";
export * as Vec from "gl-matrix";
export * as MathUtils from "./core/math";
export { clamp, lerp, damp, dampTime } from "./core/math";
export { aimFromDirection } from "./core/cameraRigMath";

// What a user script's `import { ... } from 'cleo'` resolves to: the barrel's own namespace. Must stay
// the LAST statement — the self-import only works once every re-export above has been evaluated.
import * as CleoAPI from "./cleo";
import { registerScriptModule as register } from "./core/scripting/scriptRuntime";
register('cleo', CleoAPI);
