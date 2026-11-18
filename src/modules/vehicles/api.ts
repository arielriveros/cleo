// What the Vehicles feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
export { VehicleNode } from "../../core/scene/nodes/vehicleNode";
export { WheelNode } from "../../core/scene/nodes/wheelNode";
export { Vehicle } from "../../physics/vehicle";
export type { VehicleWheelState } from "../../physics/vehicle";
export type {
    VehicleDesc, WheelDesc, VehicleEngineDesc, VehicleTransmissionDesc, VehicleDifferentialDesc, VehicleAntiRollBarDesc,
    VehicleCast, VehicleInput, VehicleDrive, VehicleLeanDesc,
} from "../../physics/pal/vehicle/vehicleDesc";
export { VEHICLE_PRESETS, applyVehiclePreset } from "../../core/scene/nodes/vehiclePresets";
export type { VehiclePreset, VehiclePresetResult, WheelSlot } from "../../core/scene/nodes/vehiclePresets";
