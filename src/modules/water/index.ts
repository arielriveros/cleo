// The Water volumes feature (catalog id `water`): water that floats bodies and ripples. Installed by the full engine
// (src/modules/all.ts); a published game built with it loads it as a chunk of its own (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { K } from "../../core/scene/sceneKinds";
import { WaterVolumeNode } from "../../core/scene/nodes/waterVolumeNode";
import * as api from "./api";
import { RENDER_FACTORY } from "../../graphics/render/featureSubsystems";
import { WaterPasses } from "../../graphics/render/water";
import type { Scene } from "../../core/scene/scene";
import { WaterSprayRig } from "../../water/spray/waterSprayRig";

export * from "./api";

const feature: FeatureModule = {
    id: 'water',
    api,
    install(reg) {
        reg.nodeType('waterVolume', (parent, json) => WaterVolumeNode.parse(parent, json));
        reg.nodeKind(WaterVolumeNode, K.WATER);
        reg.factory(RENDER_FACTORY.water, (...a: ConstructorParameters<typeof WaterPasses>) => new WaterPasses(...a));
        // The spray flowing water throws (scene.waterSpray); its particle systems come from the Particles feature.
        reg.factory('waterSpray', (scene: Scene) => new WaterSprayRig(scene));
    },
};

export default feature;
