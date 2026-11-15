// The Global illumination feature (catalog id `gi`): GI Volumes: probe grids, their capture, relight, bake and apply.
// Installed by the full engine (src/modules/all.ts); a published game built with it loads it as a chunk of its own
// (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { K } from "../../core/scene/sceneKinds";
import { GIVolumeNode } from "../../core/scene/nodes/giVolumeNode";
import { GiSystem } from "../../graphics/render/gi/giSystem";
import { RENDER_FACTORY } from "../../graphics/render/featureSubsystems";
import * as api from "./api";

export * from "./api";

const feature: FeatureModule = {
    id: 'gi',
    api,
    install(reg) {
        reg.nodeType('giVolume', (parent, json) => GIVolumeNode.parse(parent, json));
        reg.nodeKind(GIVolumeNode, K.GI);
        reg.factory(RENDER_FACTORY.gi, (...a: ConstructorParameters<typeof GiSystem>) => new GiSystem(...a));
    },
};

export default feature;
