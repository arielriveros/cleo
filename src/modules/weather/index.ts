// The Weather feature (catalog id `weather`): weather volumes and the rain and snow falling from them
// (scene.precipitation), with their particle systems. Installed by the full engine (src/modules/all.ts); a published
// game built with it loads it as a chunk of its own (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { K } from "../../core/scene/sceneKinds";
import { WeatherNode } from "../../core/scene/nodes/weatherNode";
import type { Scene } from "../../core/scene/scene";
import { PrecipitationRig } from "../../core/scene/precipitationRig";
import * as api from "./api";

export * from "./api";

const feature: FeatureModule = {
    id: 'weather',
    dependsOn: ["particles"],
    api,
    install(reg) {
        reg.nodeType('weather', (parent, json) => WeatherNode.parse(parent, json));
        reg.nodeKind(WeatherNode, K.WEATHER);
        reg.factory('precipitation', (scene: Scene) => new PrecipitationRig(scene));
    },
};

export default feature;
