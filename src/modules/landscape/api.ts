// What the Landscape feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
export { LandscapeNode } from "../../core/scene/nodes/landscapeNode";
export { Terrain } from "../../terrain/terrain";
// Terrain layer relief is off; the editor hides its authoring controls behind the same flag so
// nothing is exposed that does nothing. See the constant for why it is a flag and not a deletion.
export { TERRAIN_RELIEF_ENABLED } from "../../terrain/terrain";
export { TerrainLayerStack, defaultMaskResolution, materialSlots } from "../../terrain/terrainLayerStack";
export type { TerrainPaintLayer, TerrainBaseLayer, TerrainLayerWeights, StackLayersSnapshot } from "../../terrain/terrainLayerStack";
export { MaskGrid } from "../../terrain/terrainMasks";
export type { MaskRegion, MaskPatch, MaskPaint } from "../../terrain/terrainMasks";
export { applySculpt, brushWeight, curveWeight, readRegion, writeRegion, unionRegion, terraceHeight } from "../../terrain/sculpt";
export type { SculptTool, FalloffCurve, BrushShape, BrushSpec, SculptParams, GridRegion, HeightGrid, StampAlpha } from "../../terrain/sculpt";
export { decodeHeightmap, decodePng, decodeRaw16, encodePng16, encodeRaw16, heightsFromImage, imageFromHeights, sampleHeight } from "../../terrain/heightmapIO";
export type { HeightImage, HeightImportOptions } from "../../terrain/heightmapIO";
export { decodePngChannels, weightsToOverAlphas, weightPlanesToAlphaPlanes, readWorldManifest, weightPlanesFromImages, resamplePlane } from "../../terrain/splatmapIO";
export type { DecodedPng, WorldManifest, WorldManifestLayer } from "../../terrain/splatmapIO";
export type { TerrainConfig, SculptBrush, SculptMode, TerrainLayer, PaintBrush, TerrainChunk, TerrainLodSettings, FoliageGenerateResult } from "../../terrain/terrain";
export { FoliageLayer, crossQuadGeometry, MAX_INSTANCES, FOLIAGE_DRAW_TRIANGLE_BUDGET, foliageEffectiveCull, foliageLodBands, foliageDensityScale, FOLIAGE_DENSITY_STEPS } from "../../terrain/foliage";
export type { FoliageKind, FoliageParams } from "../../terrain/foliage";
export { FoliageInteraction, gatherFoliageInteractors, MAX_INTERACT_STAMPS, INTERACT_RANGE, type FoliageInteractor } from "../../graphics/foliageInteraction";
export { bakeOctahedralImpostor, rgbaSampler, impostorSphere } from "../../terrain/octahedralBake";
export type { OctahedralBakePart, OctahedralBakeOptions, OctahedralBakeResult } from "../../terrain/octahedralBake";
export { parseOctahedralInfo, OCTA_DEFAULT_FRAMES } from "../../terrain/octahedralImpostor";
export type { OctahedralImpostorInfo } from "../../terrain/octahedralImpostor";
export { FoliageColliderField, DEFAULT_FOLIAGE_COLLIDERS } from "../../terrain/foliageColliders";
export type { FoliageColliderSettings } from "../../terrain/foliageColliders";
