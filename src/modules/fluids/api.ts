// What the Fire & smoke volumes feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
export { FluidVolumeNode, FLUID_BRICK, OCCUPANCY_MARGIN, occupancyFromVolume, floatToHalf, floatsToHalves } from "../../core/scene/nodes/fluidVolumeNode";
