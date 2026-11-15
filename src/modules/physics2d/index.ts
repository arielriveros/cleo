// The 2D physics feature (catalog id `physics2d`): 2D character and rigid bodies, and the world that steps them
// (scene.physics2D). Installed by the full engine (src/modules/all.ts); a published game built with it loads it as a
// chunk of its own (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { CharacterBody2DNode } from "../../core/scene/nodes/characterBody2DNode";
import { Body2DNode } from "../../core/scene/nodes/body2DNode";
import { migrateLegacyBody2DJson } from "../../core/scene/nodes/body2DLegacy";
import { World2D } from "../../physics2d/world2d";
import * as api from "./api";

export * from "./api";

const feature: FeatureModule = {
    id: 'physics2d',
    api,
    install(reg) {
        reg.nodeType('characterBody2D', (parent, json) => CharacterBody2DNode.parse(parent, json), migrateLegacyBody2DJson);
        reg.nodeType('body2D', (parent, json) => Body2DNode.parse(parent, json));
        reg.factory('world2D', () => new World2D());
    },
};

export default feature;
