// The Landscape feature (catalog id `landscape`): sculpted terrain with painted layers, foliage (its passes, GPU
// culling, interaction, colliders) and impostors. Installed by the full engine (src/modules/all.ts); a published game
// built with it loads it as a chunk of its own (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { K } from "../../core/scene/sceneKinds";
import { LandscapeNode } from "../../core/scene/nodes/landscapeNode";
import { FoliagePasses } from "../../graphics/render/foliage";
import { RENDER_FACTORY } from "../../graphics/render/featureSubsystems";
import * as api from "./api";

export * from "./api";

const feature: FeatureModule = {
    id: 'landscape',
    api,
    install(reg) {
        reg.nodeType('landscape', (parent, json) => LandscapeNode.parse(parent, json));
        reg.nodeKind(LandscapeNode, K.LANDSCAPE);
        reg.factory(RENDER_FACTORY.foliage, (...a: ConstructorParameters<typeof FoliagePasses>) => new FoliagePasses(...a));
    },
};

export default feature;
