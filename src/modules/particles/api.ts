// What the Particles feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
export { ParticleSystemNode } from "../../core/scene/nodes/particleSystemNode";
export type { ParticleSystemNodeOptions, ParticleCullingMode } from "../../core/scene/nodes/particleSystemNode";
export { ForceFieldNode, MAX_FORCE_FIELDS } from "../../core/scene/nodes/forceFieldNode";
export type { ForceFieldOptions, ForceFieldKind, ForceFieldShape } from "../../core/scene/nodes/forceFieldNode";
export * from "../../particles/particleSystemAsset";
export { selectParticleLod, particleLodDistance, particleLodFactors, PARTICLE_LOD_HYSTERESIS, type ParticleLodState } from "../../particles/particleLod";
export * from "../../particles/particleModules";
export { packEmitter, stepUniforms, SIM as PARTICLE_SIM_FLAGS, DRAW as PARTICLE_DRAW_FLAGS } from "../../particles/particlePack";
export type { PackedEmitter } from "../../particles/particlePack";
export { EmitterRuntime, ParticleSystemRuntime, particleTextureLayout, PARTICLE_TEXTURE_WIDTH, resolveSubEmitters } from "../../particles/particleRuntime";
export type { SimStep, EmitterState, SubEmitterLink } from "../../particles/particleRuntime";
export { builtinParticleMesh, particleMeshFromNodeJson, parseParticleMesh, PARTICLE_MESH_TRIANGLE_WARNING } from "../../particles/particleMesh";
export type { ParticleMeshData, ParticleMeshKind } from "../../particles/particleMesh";
export { customCodeKey, composeCustomSim, validatedCustomCode } from "../../particles/particleCustomCode";
export type { CompiledCustomCode } from "../../particles/particleCustomCode";
export { setParticleGlslTranslator, hasParticleGlslTranslator, compileParticleCustomCode } from "../../graphics/particles/particleCustom";
export { FORCE_FIELD_PRESETS, type ForceFieldPreset } from "../../core/scene/nodes/forceFieldPresets";
// The built-in rain and snow sprites (weather draws them through the particle renderer).
export {
    BUILTIN_RAIN_SPRITE, BUILTIN_SNOW_SPRITE, BUILTIN_SPRITE_PREFIX, isBuiltinTextureId, builtinSpriteSheet,
} from "../../particles/precipitationSprites";
