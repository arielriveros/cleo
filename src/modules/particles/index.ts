// The Particles feature (catalog id `particles`): GPU particle systems and force fields: their runtime, modules,
// packing, meshes, custom code and the renderer's particle passes. Installed by the full engine (src/modules/all.ts);
// a published game built with it loads it as a chunk of its own (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { K } from "../../core/scene/sceneKinds";
import { ParticleSystemNode } from "../../core/scene/nodes/particleSystemNode";
import { ForceFieldNode } from "../../core/scene/nodes/forceFieldNode";
import { ParticlePasses } from "../../graphics/render/particlePasses";
import { RENDER_FACTORY } from "../../graphics/render/featureSubsystems";
import * as api from "./api";

export * from "./api";

const feature: FeatureModule = {
    id: 'particles',
    api,
    install(reg) {
        reg.nodeType('particleSystem', (parent, json) => ParticleSystemNode.parse(parent, json));
        reg.nodeType('forceField', (parent, json) => ForceFieldNode.parse(parent, json));
        reg.nodeKind(ParticleSystemNode, K.PARTICLES);
        reg.nodeKind(ForceFieldNode, K.FORCE_FIELD);
        reg.factory(RENDER_FACTORY.particles, (...a: ConstructorParameters<typeof ParticlePasses>) => new ParticlePasses(...a));
    },
};

export default feature;
