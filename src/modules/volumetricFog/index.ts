// The Volumetric fog feature (catalog id `volumetricFog`): fog volumes lit by the sun and the local lights, froxel by
// froxel (and the rain's haze, which is one). Installed by the full engine (src/modules/all.ts); a published game
// built with it loads it as a chunk of its own (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { K } from "../../core/scene/sceneKinds";
import { VolumetricFogNode } from "../../core/scene/nodes/volumetricFogNode";
import type { VolumetricFogOptions } from "../../core/scene/nodes/volumetricFogNode";
import { VolumetricFogPasses } from "../../graphics/render/volumetricFog";
import { RENDER_FACTORY } from "../../graphics/render/featureSubsystems";
import * as api from "./api";

export * from "./api";

const feature: FeatureModule = {
    id: 'volumetricFog',
    api,
    install(reg) {
        reg.nodeType('volumetricFog', (parent, json) => VolumetricFogNode.parse(parent, json));
        reg.nodeKind(VolumetricFogNode, K.FOG);
        reg.factory('fogVolume', (name: string, options: VolumetricFogOptions, id: string) => new VolumetricFogNode(name, options, id));
        reg.factory(RENDER_FACTORY.volumetricFog, (...a: ConstructorParameters<typeof VolumetricFogPasses>) => new VolumetricFogPasses(...a));
    },
};

export default feature;
