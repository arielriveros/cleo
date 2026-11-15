// What the Decals feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
export { DecalNode, decalLocalToUV, radialDecalWeight, radialDecalT, DECAL_RADIAL_CURVES, decalFlipbookFrame, decalFlipbookFrom } from "../../core/scene/nodes/decalNode";
export type { DecalOptions, DecalAffects, DecalRadialPattern, DecalRadialCurve, DecalRadialShape, DecalReceivers, DecalPattern, DecalColor, DecalFlipbook, DecalFlipbookFrame } from "../../core/scene/nodes/decalNode";
