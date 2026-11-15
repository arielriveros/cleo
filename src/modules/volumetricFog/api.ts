// What the Volumetric fog feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
export { VolumetricFogNode, VOLUMETRIC_FOG_PRESETS, MIN_FOG_VOLUME_SIZE } from "../../core/scene/nodes/volumetricFogNode";
export type { VolumetricFogOptions, VolumetricFogPreset } from "../../core/scene/nodes/volumetricFogNode";
