/**
 * The ONE place the engine imports Yuka.
 *
 * Every other module in `core/ai` imports from here, never from `'yuka'` directly. Three reasons, and
 * the third is the one that bites:
 *
 *  1. One file shows the entire surface we depend on. Yuka exports 104 names; we use a dozen.
 *  2. One file to change if the library is ever vendored or patched. It has been feature-frozen since
 *     January 2023, so that is a real possibility rather than a hypothetical one.
 *  3. `@types/yuka` is a DefinitelyTyped package that trails the runtime by a minor version — the
 *     library itself ships no declarations. Keeping the lag behind one seam means a type gap is fixed
 *     in one file rather than wherever it happens to surface.
 *
 * ## What is deliberately NOT here
 *
 * Yuka's plumbing, all of which the engine already does better:
 *
 *  - `Vehicle` / `MovingEntity` / `SteeringManager` and the 14 steering behaviours — `core/control`
 *    owns motion. An NPC steers through `steering.ts` and moves through `stepLocomotion`, so it gets
 *    the slope handling, the gravity-relative planar rule and the animation the player character has.
 *  - Every `toJSON` / `fromJSON` — they key off `constructor.name`, which the published player
 *    minifies. We serialize our own records.
 *  - `MessageDispatcher` / `Telegram` — `dispatchDelayedMessages` pops the last entry instead of
 *    splicing the one it just handled, so a second queued telegram is discarded. `engineEventBus`
 *    exists and works.
 *  - `StateMachine` / `State` — `behavior.ts` over `conditions.ts` is better and already has editor UI.
 *  - `Trigger` / `TriggerRegion` — brute-force, top-level entities only, and its two region kinds
 *    disagree about local vs world space. The engine has physics triggers.
 *  - `Time` / `Regulator` — the engine owns the frame delta, and `Regulator` builds a `Time` it never
 *    disposes, leaking a `visibilitychange` listener per instance.
 *
 * ## Non-reentrancy
 *
 * Yuka keeps module-level scratch vectors in `NavMesh`, `Vision`, `BVH` and every behaviour. Two nav
 * queries must never interleave — which in practice means never `await` between one and the next.
 */

export {
    // Navigation. The reason this dependency exists: a funnel-smoothed path through merged convex
    // regions is a genuinely hard thing to get right, and this implementation does.
    NavMesh,
    Corridor,
    Polygon,

    // The graph underneath it. Exposed because off-mesh links have to search it directly — Yuka's own
    // `findPath` string-pulls through shared portal edges and cannot traverse a synthetic edge.
    Graph,
    NavNode,
    NavEdge,
    AStar,
    Dijkstra,

    // Perception. Vision rejects on range, then the cone, then obstacles -- so the raycast budget is
    // proportional to what is actually in front of an agent, not to how many candidates exist.
    Vision,
    MemorySystem,
    MemoryRecord,
    GameEntity,

    // Fuzzy logic. The seven set shapes, the four hedges, and the module that combines them -- the
    // machinery behind "how much do I want this, given several things that are each a matter of
    // degree", which a threshold answers badly.
    FuzzyModule,
    FuzzyVariable,
    FuzzyRule,
    FuzzyAND,
    FuzzyOR,
    FuzzyVERY,
    FuzzyFAIRLY,
    TriangularFuzzySet,
    LeftShoulderFuzzySet,
    RightShoulderFuzzySet,
    LeftSCurveFuzzySet,
    RightSCurveFuzzySet,
    NormalDistFuzzySet,
    SingletonFuzzySet,

    // Math. Only ever crossed at the `interop.ts` boundary; nothing else should hold one of these.
    Vector3,
    Quaternion,
    Matrix4,
    Ray,
} from 'yuka';

export type { FuzzySet, FuzzyTerm } from 'yuka';
