export { CleoEngine } from "./core/engine";
export { Camera } from "./core/camera";
export { Geometry } from "./core/geometry";
export { Scene } from "./core/scene/scene";
export type { InstantiateOptions } from "./core/scene/scene";
export { registerTemplates, clearTemplates, getTemplate, templateNames } from "./core/scene/templates";
export type { NodeTemplate } from "./core/scene/templates";
export { parseNodeJson } from "./core/scene/node";
export { cloneNodeJson, collectNodeIds, remapNodeRefs, regenerateNodeIds } from "./core/scene/nodeJson";
export { Node, ModelNode, LightNode, LightProbeNode, SkyboxNode, CameraNode, CameraRigNode, SpriteNode, AnimatedSpriteNode, LandscapeNode, TilemapNode, LodGroupNode, VolumetricCloudsNode, SkyAtmosphereNode, getData, setData, bindDataAccessors, canAccessVariable, attachScriptFactory, unwrapScriptNode } from "./core/scene/node";
export type { NodeVariable, NodeVariableType, NodeVariableAccess, VolumetricCloudsOptions, SkyAtmosphereOptions, FollowSpace, AimMode } from "./core/scene/node";
export { Logger } from "./core/logger";
export type { LogEntry, LogMethod, LogOptions } from "./core/logger";
export { TypedEmitter, engineEventBus } from "./core/eventBus";
export type { EngineEventMap, SceneChange, ChangeKind, StructureOp, NodePlacement } from "./core/eventBus";
export { HistoryManager } from "./core/history";
export type { HistoryEntry, HistoryOptions } from "./core/history";
export { Mesh } from "./graphics/mesh";
export { Material, TerrainMaterial, CustomMaterial, FOLIAGE_DENSITY_UNIT, DEFAULT_FOLIAGE_DENSITY, migrateFoliageRule } from "./graphics/material";
export type { TerrainBaseType, TerrainFoliageRule, FoliageCollision, CustomBaseType, CustomRenderMode, CustomUniform, CustomUniformType } from "./graphics/material";
export { customSeedTemplate, customSeedUniforms, tryCompileCustom, assembleCustomFragment } from "./graphics/systems/customShaders";
export { Renderer } from "./graphics/renderer";
export type { SkeletonOverlay, RenderSettings } from "./graphics/renderer";
export { Skybox } from "./graphics/skybox";
export { Texture } from "./graphics/texture";
export { Loader } from "./graphics/loader";
// The pure (no DOM, no GL) half of model import, so the editor can run it inside a Web Worker.
// Pair with Loader.assembleAssimpModels, which does the GL half on the main thread.
export { parseAssimpFiles, parseResultTransferables } from "./graphics/utils/assimpLoader";
export type { AssimpParseResult, ParsedMesh, OutputMaterial } from "./graphics/utils/assimpLoader";
export { GLTFLoader } from "./graphics/utils/gltfLoader";
export type { GltfParseResult, GltfMeshDescriptor, GltfMaterialDescriptor, GltfImageSource } from "./graphics/utils/gltfLoader";
export { InputManager } from "./input/inputManager";
export { TextureManager } from "./graphics/systems/textureManager";
export { RigidBody as Body, Trigger } from "./physics/body";
export { Ragdoll, RAGDOLL_DEFAULTS } from "./physics/ragdoll";
export type { RagdollOptions } from "./physics/ragdoll";
export { Model } from "./graphics/model";
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
export { Sprite } from "./graphics/sprite";
export { DirectionalLight, PointLight, Spotlight } from "./graphics/lighting";
export { Shape } from "./physics/shape";
// Scene.physics is a public field of this type and scripts already reach through it (startRagdoll,
// isGrounded), so the class belongs in the public surface too.
export { PhysicsSystem } from "./physics/physicsSystem";
export type { PhysicsRaycastHit, PhysicsRaycastOptions } from "./physics/physicsSystem";
export { physicsStats } from "./physics/physicsStats";
export type { PhysicsStats } from "./physics/physicsStats";
export { sceneStats, sceneStatsDetail } from "./core/scene/sceneStats";
export type { SceneStats } from "./core/scene/sceneStats";
export { convexHull, hullFromPositions, HULL_BUDGETS } from "./physics/convexHull";
export type { Hull, HullQuality } from "./physics/convexHull";
export { Terrain } from "./terrain/terrain";
export type { TerrainConfig, SculptBrush, SculptMode, TerrainLayer, PaintBrush, TerrainChunk, TerrainLodSettings, FoliageGenerateResult } from "./terrain/terrain";
export { FoliageLayer, crossQuadGeometry, MAX_INSTANCES } from "./terrain/foliage";
export type { FoliageKind, FoliageParams } from "./terrain/foliage";
export { FoliageColliderField, DEFAULT_FOLIAGE_COLLIDERS } from "./terrain/foliageColliders";
export type { FoliageColliderSettings } from "./terrain/foliageColliders";
export { Tilemap, DEFAULT_FILL_LIMIT } from "./tilemap/tilemap";
export type { TileEdit, TileOrientation } from "./tilemap/tilemap";
export { TilemapLayer, defaultLayerConfig } from "./tilemap/tilemapLayer";
export type { TilemapLayerConfig, LayerBounds } from "./tilemap/tilemapLayer";
export { Tileset } from "./tilemap/tileset";
export type { TilesetConfig, TileMeta, TileAnimation, TerrainSet, VariantSet, WangKind } from "./tilemap/tileset";
export {
    cellToWorld, worldToCell, cellCorners, cellSortY, neighbours, neighbourCount, normalizeGrid,
} from "./tilemap/cellMath";
export type { GridSpec, GridKind, HexOrientation, HexOffset } from "./tilemap/cellMath";
export {
    CHUNK_SIZE, CELL_EMPTY, packCell, cellTile, cellFlags, cellFlipX, cellFlipY, cellRot90, withTile, chunkKey, chunkCoord,
} from "./tilemap/chunk";
export type { TileChunk } from "./tilemap/chunk";
export { autoTileMask, resolveAutoTile, pickWeightedVariant, cellNoise } from "./tilemap/autotile";
export { greedyMerge } from "./tilemap/tilemapCollision";
export type { SolidBox } from "./tilemap/tilemapCollision";
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
// The namespace keeps the surface tidy; clamp/lerp/damp/dampTime are also named because they are
// what gameplay scripts reach for constantly and `MathUtils.clamp` is pure friction.
export * as MathUtils from "./core/math";
export { clamp, lerp, damp, dampTime } from "./core/math";
export { aimFromDirection } from "./core/cameraRigMath";

// This is what a user script's `import { ... } from 'cleo'` resolves to: the barrel's own namespace,
// so everything exported above is importable from a script with no injection list to maintain. The
// self-import is safe — every re-export above has been evaluated by the time this last statement runs.
import * as CleoAPI from "./cleo";
import { registerScriptModule as register } from "./core/scripting/scriptRuntime";
register('cleo', CleoAPI);