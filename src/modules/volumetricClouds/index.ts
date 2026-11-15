// The Volumetric clouds feature (catalog id `volumetricClouds`): raymarched cloud layers, their temporal
// reconstruction and the sky's cloud bake. Installed by the full engine (src/modules/all.ts); a published game built
// with it loads it as a chunk of its own (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { K } from "../../core/scene/sceneKinds";
import { VolumetricCloudsNode } from "../../core/scene/nodes/volumetricCloudsNode";
import { VolumetricCloudPasses } from "../../graphics/render/clouds";
import { RENDER_FACTORY } from "../../graphics/render/featureSubsystems";
import * as api from "./api";

export * from "./api";

const feature: FeatureModule = {
    id: 'volumetricClouds',
    api,
    install(reg) {
        reg.nodeType('volumetricClouds', (parent, json) => VolumetricCloudsNode.parse(parent, json));
        reg.nodeKind(VolumetricCloudsNode, K.CLOUDS);
        reg.factory(RENDER_FACTORY.clouds, (...a: ConstructorParameters<typeof VolumetricCloudPasses>) => new VolumetricCloudPasses(...a));
    },
};

export default feature;
