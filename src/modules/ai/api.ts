// What the AI navigation feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
// Navigation. Yuka supplies the funnel and the region merge; everything that touches the engine is
// ours, and no Yuka TYPE is re-exported here on purpose -- `cleoTypes.ts` feeds dist's declarations to
// Monaco alongside a hand-listed set of `?raw` dependency types, and a dependency it has not been told
// about degrades to `any` silently, because skipLibCheck swallows it.
export {
    NavMeshNode, parseRoutes, parseLinks, parseSize, parseBakedVolume, isDefaultNavMeshSettings,
} from "../../core/scene/nodes/navMeshNode";
export {
    SoupBuilder, carveSoup, clipSoupToVolume, foliageNavObstacles, heightfieldSoup, mergeSoups, navObstacleFor,
    navSourceForShape,
    tessellateSource, tessellateSources,
} from "../../ai/navSources";
export type {
    HeightfieldSource, NavCarveOptions, NavObstacle, NavPrimitive, NavShapeDescription, NavSource,
} from "../../ai/navSources";
export {
    DEFUZZIFICATIONS, EMPTY_FUZZY_MODEL, FUZZY_SET_SHAPES, FuzzyBrain, buildFuzzyModule,
    isDefaultFuzzyModel, parseFuzzyModel, parseFuzzyRule, parseFuzzySet, parseFuzzyTerm,
    parseFuzzyVariable,
} from "../../ai/fuzzy";
export type {
    Defuzzification, FuzzyModel, FuzzyRuleDefinition, FuzzySetDefinition, FuzzySetShape,
    FuzzyTermNode, FuzzyVariableDefinition,
} from "../../ai/fuzzy";
export {
    EMPTY_GOAL_GRAPH, GoalBrain, buildGoalBrain, isDefaultGoalGraph, parseDesirability,
    parseGoalDefinition, parseGoalGraph,
} from "../../ai/goals";
export type {
    DesirabilityDefinition, GoalContext, GoalDefinition, GoalGraph,
} from "../../ai/goals";
export { PERCEPTION_DEFAULTS, Perception, perceptionTuning } from "../../ai/perception";
export type {
    LineOfSightTest, PerceptionCandidate, PerceptionTuning, Sighting,
} from "../../ai/perception";
export {
    CleoNavMesh, EMPTY_NAV_MESH_DATA, buildNavMesh, buildNavMeshShared, clearSharedNavMeshes, isNavigableUp,
    navBuildStats, navMeshDataKey, parseNavMeshData, polygonsFromData, serializeNavMeshData,
} from "../../ai/navMesh";
export type { NavMeshData, NavMeshJson, NavMeshBuildOptions, NavRoute, OffMeshLink } from "../../ai/navMesh";
export {
    NAV_BAKE_DEFAULTS, EMPTY_BAKE_RESULT, bakeNavMesh, navBakeSettings, simplifyContour,
    triangleSlope, walkableSoup,
} from "../../ai/navBake";
export type { NavBakeInput, NavBakeSettings, NavBakeResult, TriangleSoup } from "../../ai/navBake";
// 2D navigation: a platform graph (walks, jumps, drops) or an air grid, baked from the 2D collision world.
export {
    NavGraph2D, bakeNavGraph2D, serializeNavGraph2D, parseNavGraph2D, navGraph2DSourceHash, EMPTY_NAV_GRAPH_2D,
    EDGE_WALK, EDGE_JUMP, EDGE_DROP, EDGE_DROP_THROUGH, EDGE_FLY,
} from "../../ai/navGraph2D";
export type { NavGraph2DData, NavBakeStats2D, NavBounds2D } from "../../ai/navGraph2D";
