// The AI navigation feature (catalog id `ai`): navmeshes (baking, querying, 2D nav graphs, nav sources) and the AI
// controllers' yuka-backed perception, fuzzy and goal brains. Installed by the full engine (src/modules/all.ts); a
// published game built with it loads it as a chunk of its own (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { K } from "../../core/scene/sceneKinds";
import { NavMeshNode } from "../../core/scene/nodes/navMeshNode";
import { Perception } from "../../ai/perception";
import { FuzzyBrain } from "../../ai/fuzzy";
import { GoalBrain } from "../../ai/goals";
import type { FuzzyModel } from "../../ai/fuzzyModel";
import type { GoalGraph } from "../../ai/goalGraph";
import * as api from "./api";

export * from "./api";

const feature: FeatureModule = {
    id: 'ai',
    api,
    install(reg) {
        reg.nodeType('navMesh', (parent, json) => NavMeshNode.parse(parent, json));
        reg.nodeKind(NavMeshNode, K.NAV_MESH);
        // What an AI-driven controller (ControllerNode) builds its eyes and brains with.
        reg.factory('ai.perception', () => new Perception());
        reg.factory('ai.fuzzyBrain', (model: FuzzyModel) => FuzzyBrain.from(model));
        reg.factory('ai.goalBrain', (graph: GoalGraph) => GoalBrain.from(graph));
    },
};

export default feature;
