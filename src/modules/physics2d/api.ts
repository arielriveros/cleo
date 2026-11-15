// What the 2D physics feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
export { CharacterBody2DNode } from "../../core/scene/nodes/characterBody2DNode";
export { Body2DNode } from "../../core/scene/nodes/body2DNode";
export type { Body2DKind } from "../../core/scene/nodes/body2DNode";
export { World2D } from "../../physics2d/world2d";
