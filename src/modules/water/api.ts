// What the Water volumes feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
export { WaterVolumeNode, WATER_RIPPLE_SLOTS } from "../../core/scene/nodes/waterVolumeNode";
export type { WaterVolumeOptions } from "../../core/scene/nodes/waterVolumeNode";
export { WATER_VOLUME_PRESETS, type WaterVolumePreset } from "../../core/scene/nodes/waterVolumePresets";
export {
    WATER_BODY_TYPES, normaliseWaterBody, normaliseWaterPoint, cloneWaterBody, retypeWaterBody, defaultWaterPoints,
    minWaterPoints, resolveWaterBody, waterColumnAt, waterShapesBounds, legacyWaterShapes,
    type WaterBody, type WaterBodyType, type WaterPoint, type WaterCarve, type WaterConnect, type WaterTargets,
    type ResolvedWaterShape, type WaterColumn,
} from "../../water/waterShapes";
export { carveWater, type CarveGrid, type CarveRegion } from "../../water/carve";
export { buildWaterInfo, handOverWaterInfo, type WaterInfo, type GroundSampler } from "../../water/waterInfo";
export { sceneGround, heightsRegionKey, groundRegionKey } from "../../water/ground";
export {
    ShallowWaterBake, bakeWater, riverDischarge, DEFAULT_MANNING,
    type WaterBakeSetup, type WaterBakeMember, type WaterBakeSettle, type WaterBakeReport, type WaterBakeOutput,
} from "../../water/bake/shallowWater";
export {
    prepareWaterGroup, prepareWaterBake, bakeShallowWater, groupReach, bodyReach, riverCorridor, WATER_BAKE_DEPTH_CAP,
    type WaterGroupMember, type WaterGroupOptions,
} from "../../water/bake/groupSetup";
export {
    prepareGroupBake, waterBakeGroup, waterGroupBoundary, waterGroupReach, waterGroupSignature, forgetWaterBakeContext, bakeable,
} from "../../water/bake/bakeNode";
export { sceneObstacles, obstacleSpan, obstaclesKey, type WaterObstacle } from "../../water/bake/obstacles";
export { encodeWaterBake, decodeWaterBake, newWaterBakeId } from "../../water/bake/waterBakeFormat";
