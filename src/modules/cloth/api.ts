// What the Cloth feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
export { ClothNode, CLOTH_DEFAULTS, jointOf as clothJointOf } from "../../core/scene/nodes/clothNode";
export type { ClothOptions, ClothPinEdge } from "../../core/scene/nodes/clothNode";
export { XpbdCloth, CLOTH_SOLVER_DEFAULTS, gridIndices, windGust } from "../../physics/cloth/xpbdCloth";
export type { ClothCapsule, ClothSettings } from "../../physics/cloth/xpbdCloth";
export { weightsFromCloth, clothFromWeights, settingsOf as clothSettingsOf, twinsOf as clothTwinsOf, neighboursOf as clothNeighboursOf, brushDab as clothBrushDab, fillPiece as clothFillPiece, fillRange as clothFillRange, DEFAULT_CLOTH_SETTINGS } from "../../physics/cloth/clothPaint";
export type { ClothSettings as SkinnedClothSettings, ClothBrushMode, ClothDab } from "../../physics/cloth/clothPaint";
