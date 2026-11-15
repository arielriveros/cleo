// What the Water volumes feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
export { WaterVolumeNode, WATER_RIPPLE_SLOTS } from "../../core/scene/nodes/waterVolumeNode";
export type { WaterVolumeOptions } from "../../core/scene/nodes/waterVolumeNode";
export { WATER_VOLUME_PRESETS, type WaterVolumePreset } from "../../core/scene/nodes/waterVolumePresets";
