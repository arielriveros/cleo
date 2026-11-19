// The Vehicles feature (catalog id `vehicles`): vehicle and wheel nodes. Installed by the full engine
// (src/modules/all.ts); a published game built with it loads it as a chunk of its own (src/modules/loaders.ts).
// The simulation itself (pal/vehicle/, each backend's vehicle) is part of the physics layer.
import type { FeatureModule } from "../../core/features/registry";
import { VehicleNode } from "../../core/scene/nodes/vehicleNode";
import { WheelNode } from "../../core/scene/nodes/wheelNode";
import * as api from "./api";

export * from "./api";

const feature: FeatureModule = {
    id: 'vehicles',
    api,
    install(reg) {
        reg.nodeType('vehicle', (parent, json) => VehicleNode.parse(parent, json));
        reg.nodeType('wheel', (parent, json) => WheelNode.parse(parent, json));
    },
};

export default feature;
