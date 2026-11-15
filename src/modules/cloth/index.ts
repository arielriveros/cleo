// The Cloth feature (catalog id `cloth`): cloth nodes and the cloth parts of skinned models. Installed by the full engine
// (src/modules/all.ts); a published game built with it loads it as a chunk of its own (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { K } from "../../core/scene/sceneKinds";
import { ClothNode } from "../../core/scene/nodes/clothNode";
import { SkinnedCloth } from "../../physics/cloth/skinnedCloth";
import * as api from "./api";

export * from "./api";

const feature: FeatureModule = {
    id: 'cloth',
    api,
    install(reg) {
        reg.nodeType('cloth', (parent, json) => ClothNode.parse(parent, json));
        reg.nodeKind(ClothNode, K.CLOTH);
        // A skinned model's cloth parts (AnimatedModel.skinnedCloth), simulated by ModelNode.stepSkinnedCloth.
        reg.factory('skinnedCloth', (model: any, data: any) => new SkinnedCloth(model, data));
    },
};

export default feature;
