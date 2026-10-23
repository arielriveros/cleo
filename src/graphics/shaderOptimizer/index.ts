/**
 * The shader optimizer: how shader programs, pipelines and material parameters reach the GPU.
 *
 * Built on the guidance in MJP's "The Shader Permutation Problem" (part 2): compile only what a game
 * uses (programUsage.ts already does), keep runtime branches where they are cheap (the `has*` material
 * flags), make PERMUTATIONS only of what a branch cannot express — `discard` and early-Z are the textbook
 * case, hence the `opaque` G-buffer variants — and treat pipeline creation as its own problem, solved by
 * recording, warming and building in the background with an uber-program stand-in.
 *
 * | Piece | Removes |
 * |---|---|
 * | `opaque` variants (programVariants.ts, CLEO_OPAQUE) | the lost early-Z of every opaque PBR draw |
 * | {@link ProgramCompileQueue} | the mid-frame stall of a program nobody built at boot |
 * | pipeline recipes (pipelineRecipes.ts) | the first-draw stall of every new WebGPU pipeline |
 * | {@link MaterialSync} | re-sending a material's parameters that are already in the block |
 * | {@link DrawSortKeys} | program/material thrash, and back-to-front overdraw within a state group |
 *
 * Counters for all of it: {@link shaderOptimizerStats}, shown in the Performance panel's Shaders rows.
 */
export { MaterialSync, MATERIAL_VIEW_SIZE } from './materialSync';
export { DrawSortKeys, depthBucket } from './drawSort';
export { ProgramCompileQueue } from './compileQueue';
export type { CompileDevice } from './compileQueue';
export { parseRecipe, parseRecipes, serializeRecipe } from './pipelineRecipes';
export type { PipelineRecipe, RecipeVertexShape } from './pipelineRecipes';
export { shaderOptimizerStats, resetShaderOptimizerFrame, recordStall } from './stats';
export type { ShaderOptimizerStats } from './stats';
