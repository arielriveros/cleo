export { CleoEngine } from "./core/engine";
export { Camera } from "./core/camera";
export { Geometry } from "./core/geometry";
export { Scene } from "./core/scene/scene";
export { Node, ModelNode, LightNode, LightProbeNode, SkyboxNode, CameraNode, SpriteNode, AnimatedSpriteNode, LandscapeNode, LodGroupNode, VolumetricCloudsNode, SkyAtmosphereNode, getData, setData, bindDataAccessors, canAccessVariable, attachScriptFactory, unwrapScriptNode } from "./core/scene/node";
export type { NodeVariable, NodeVariableType, NodeVariableAccess, VolumetricCloudsOptions, SkyAtmosphereOptions } from "./core/scene/node";
export { Logger } from "./core/logger";
export type { LogEntry, LogMethod, LogOptions } from "./core/logger";
export { Mesh } from "./graphics/mesh";
export { Material, TerrainMaterial, CustomMaterial } from "./graphics/material";
export type { TerrainBaseType, TerrainFoliageRule, CustomBaseType, CustomRenderMode, CustomUniform, CustomUniformType } from "./graphics/material";
export { customSeedTemplate, customSeedUniforms, tryCompileCustom, assembleCustomFragment } from "./graphics/systems/customShaders";
export { Renderer } from "./graphics/renderer";
export type { SkeletonOverlay, RenderSettings } from "./graphics/renderer";
export { Skybox } from "./graphics/skybox";
export { Texture } from "./graphics/texture";
export { Loader } from "./graphics/loader";
export { InputManager } from "./input/inputManager";
export { TextureManager } from "./graphics/systems/textureManager";
export { RigidBody as Body, Trigger } from "./physics/body";
export { Ragdoll, RAGDOLL_DEFAULTS } from "./physics/ragdoll";
export type { RagdollOptions } from "./physics/ragdoll";
export { Model } from "./graphics/model";
export { AnimatedModel } from "./graphics/animatedModel";
export type { Skin, Joint, Animation, AnimationSampler, AnimationChannel } from "./graphics/animatedModel";
export { remapAnimationToSkin } from "./graphics/animationRetarget";
export type { AnimationCompatibility, HierarchyMismatch } from "./graphics/animationRetarget";
export { Animator, isConditionGroup } from "./graphics/animator";
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
export { convexHull, hullFromPositions, HULL_BUDGETS } from "./physics/convexHull";
export type { Hull, HullQuality } from "./physics/convexHull";
export { Terrain } from "./terrain/terrain";
export type { TerrainConfig, SculptBrush, SculptMode, TerrainLayer, PaintBrush, TerrainChunk, TerrainLodSettings } from "./terrain/terrain";
export { FoliageLayer, crossQuadGeometry } from "./terrain/foliage";
export type { FoliageKind, FoliageParams } from "./terrain/foliage";
export { Raycaster } from "./core/raycaster";
export type { Ray, RaycastHit } from "./core/raycaster";
export { BVH, rayTriangleIntersection } from "./core/bvh";
export type { BVHHit } from "./core/bvh";
export { Frustum } from "./core/frustum";
export { bytesToBase64, base64ToBytes, bytesToDataUrl, parseBase64DataUri } from "./core/base64";
export { registerScriptModule, resolveScriptModule, createScriptImporter, compileScript, buildFactoryBody, SCRIPT_HANDLERS } from "./core/scripting/scriptRuntime";
export type { ScriptModule, ScriptFactory } from "./core/scripting/scriptRuntime";
export { Game, setGameHost } from "./core/game";
export type { GameHost } from "./core/game";
export * as Vec from "gl-matrix";

// This is what a user script's `import { ... } from 'cleo'` resolves to: the barrel's own namespace,
// so everything exported above is importable from a script with no injection list to maintain. The
// self-import is safe — every re-export above has been evaluated by the time this last statement runs.
import * as CleoAPI from "./cleo";
import { registerScriptModule as register } from "./core/scripting/scriptRuntime";
register('cleo', CleoAPI);