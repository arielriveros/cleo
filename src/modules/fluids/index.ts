// The Fire & smoke volumes feature (catalog id `fluids`): simulated smoke-and-fire volumes (FluidVolumeNode) and
// their raymarch. Installed by the full engine (src/modules/all.ts); a published game built with it loads it as a
// chunk of its own (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { K } from "../../core/scene/sceneKinds";
import { FluidVolumeNode } from "../../core/scene/nodes/fluidVolumeNode";
import { FluidVolumePasses } from "../../graphics/render/fluids";
import { RENDER_FACTORY } from "../../graphics/render/featureSubsystems";
import * as api from "./api";

export * from "./api";

const feature: FeatureModule = {
    id: 'fluids',
    api,
    install(reg) {
        reg.nodeKind(FluidVolumeNode, K.FLUID);
        reg.factory(RENDER_FACTORY.fluids, (...a: ConstructorParameters<typeof FluidVolumePasses>) => new FluidVolumePasses(...a));
    },
};

export default feature;
