// The Decals feature (catalog id `decals`): decal volumes projected onto surfaces. Installed by the full engine
// (src/modules/all.ts); a published game built with it loads it as a chunk of its own (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { K } from "../../core/scene/sceneKinds";
import { DecalNode } from "../../core/scene/nodes/decalNode";
import { DecalPasses } from "../../graphics/render/decals";
import { RENDER_FACTORY } from "../../graphics/render/featureSubsystems";
import * as api from "./api";

export * from "./api";

const feature: FeatureModule = {
    id: 'decals',
    api,
    install(reg) {
        reg.nodeType('decal', (parent, json) => DecalNode.parse(parent, json));
        reg.nodeKind(DecalNode, K.DECAL);
        reg.factory(RENDER_FACTORY.decals, (...a: ConstructorParameters<typeof DecalPasses>) => new DecalPasses(...a));
    },
};

export default feature;
