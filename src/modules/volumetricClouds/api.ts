// What the Volumetric clouds feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
export { VolumetricCloudsNode } from "../../core/scene/nodes/volumetricCloudsNode";
export type { VolumetricCloudsOptions } from "../../core/scene/nodes/volumetricCloudsNode";
export { VOLUMETRIC_CLOUDS_PRESETS } from "../../core/scene/nodes/volumetricCloudsPresets";
export type { VolumetricCloudsPreset } from "../../core/scene/nodes/volumetricCloudsPresets";
