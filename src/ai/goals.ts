/**
 * Goal-driven brains: what an agent is trying to achieve, and how it decomposes.
 *
 * The alternative to `core/control/behavior.ts`, not a replacement for it. A state machine answers
 * "what am I doing, and what makes me stop"; a goal brain answers "what is worth doing right now, and
 * what does that break down into". Two differences earn it:
 *
 *  - **Goals NEST.** "Attack" is "get within reach", then "strike". A machine has to flatten that into
 *    states that each know what comes next, which is where a transition table stops being readable.
 *  - **Goals ARBITRATE by score rather than by edge.** Adding a tenth behaviour to a machine means
 *    considering its edges to the other nine; adding a tenth goal means writing one desirability.
 *
 * Wraps Yuka's `Think`, `Goal`, `CompositeGoal` and `GoalEvaluator` — the status lifecycle, the
 * subgoal stack and the arbitration are real machinery, and the fiddly part (when a finished subgoal
 * is popped, how failure propagates to its parent) is exactly what is easy to get subtly wrong.
 *
 * A LEAF: no Node, no scene, no physics. Everything the world can say arrives through
 * {@link GoalContext}, which is the same trick `stepLocomotion` uses with `LocomotionSense`.
 *
 * ## Yuka's generic says GameEntity; nothing here is one
 *
 * `Goal<T extends GameEntity>` only ever STORES its owner — `Think.arbitrate` hands it to the
 * evaluators and nothing in the goal machinery calls a GameEntity method on it. So the owner is our
 * own context object, cast at the boundary. Verified against the source rather than assumed, because
 * it is the one thing that would break silently on a Yuka upgrade.
 *
 * ## Three semantics, all measured rather than read
 *
 *  1. **`addSubgoal` puts a goal at the FRONT of a stack popped from the back**, so the first subgoal
 *     added is the first to run. Authored order is execution order.
 *  2. **`Think.arbitrate` compares with `>=`, so a tie goes to the LAST-registered evaluator.**
 *  3. **The initial best desirability is `-1`, so a lone evaluator scoring 0 still wins.** An
 *     evaluator cannot abstain — which is why {@link GoalGraph} treats a zero score as "eligible but
 *     unwanted" and why an idle fallback is worth authoring rather than relying on nothing winning.
 */

import { clamp, finiteOr } from "../core/math";
import { Goal, CompositeGoal, GoalEvaluator, Think } from "./yuka";
import type { AiGoal, BehaviorParameterSource } from "../core/control/behavior";
import type { ConditionGroup } from "../core/conditions";
import { type GoalDefinition, type DesirabilityDefinition, type GoalGraph, type GoalContext } from './goalGraph';
// The data half (parsing, defaults) lives in ./goalGraph, which the engine's core reads without this module.
export * from './goalGraph';

// ---------------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------------

/** The owner Yuka's goals carry. Ours, not a GameEntity — see the module header. */
interface GoalOwner {
    ctx: GoalContext | null;
    byName: Map<string, GoalDefinition>;
}

type AnyGoal = Goal<never>;

/** A leaf: drives a steering verb until its `until` or `failWhen` says otherwise. */
class DataGoal extends (Goal as unknown as new (owner?: unknown) => AnyGoal) {
    constructor(public definition: GoalDefinition, public host: GoalOwner) {
        super(host as never);
    }

    public execute(): void {
        const ctx = this.host.ctx;
        if (!ctx) return;
        // Failure first: a goal that has both met is failed, not completed. "I am within reach" and
        // "my target died" want the second answer.
        if (this.definition.failWhen && ctx.met(this.definition.failWhen)) {
            this.status = Goal.STATUS.FAILED;
            return;
        }
        if (this.definition.until && ctx.met(this.definition.until)) {
            this.status = Goal.STATUS.COMPLETED;
            return;
        }
        ctx.drive(this.definition.goal, this.definition.targetKey, this.definition.speedScale ?? 1);
    }
}

/** A composite: runs its subgoals in authored order and finishes when the last one does. */
class DataCompositeGoal extends (CompositeGoal as unknown as new (owner?: unknown) => AnyGoal & {
    subgoals: AnyGoal[];
    addSubgoal(goal: AnyGoal): unknown;
    clearSubgoals(): unknown;
    executeSubgoals(): string;
    hasSubgoals(): boolean;
}) {
    constructor(public definition: GoalDefinition, public host: GoalOwner) {
        super(host as never);
    }

    public activate(): void {
        this.clearSubgoals();
        // Authored order IS execution order: addSubgoal fronts a stack that pops from the back.
        for (const name of this.definition.subgoals ?? []) {
            const child = this.host.byName.get(name);
            if (child) this.addSubgoal(buildGoal(child, this.host));
        }
    }

    public execute(): void {
        const ctx = this.host.ctx;
        if (!ctx) return;
        if (this.definition.failWhen && ctx.met(this.definition.failWhen)) {
            this.status = Goal.STATUS.FAILED;
            return;
        }
        if (this.definition.until && ctx.met(this.definition.until)) {
            this.status = Goal.STATUS.COMPLETED;
            return;
        }
        // Yuka pops finished subgoals off the back and reports the aggregate.
        this.status = this.executeSubgoals();
    }

    public terminate(): void {
        this.clearSubgoals();
    }
}

function buildGoal(definition: GoalDefinition, host: GoalOwner): AnyGoal {
    return definition.subgoals && definition.subgoals.length > 0
        ? new DataCompositeGoal(definition, host) as unknown as AnyGoal
        : new DataGoal(definition, host) as unknown as AnyGoal;
}

/** Maps one readable value onto a desirability, then applies the bias. */
class DataEvaluator extends (GoalEvaluator as unknown as new (bias?: number) => {
    characterBias: number;
    calculateDesirability(owner: unknown): number;
    setGoal(owner: unknown): void;
}) {
    constructor(public definition: DesirabilityDefinition, private readonly _think: {
        currentSubgoal(): AnyGoal | null; clearSubgoals(): unknown; addSubgoal(g: AnyGoal): unknown;
    }, private readonly _host: GoalOwner) {
        super(definition.bias);
    }

    public calculateDesirability(): number {
        const ctx = this._host.ctx;
        if (!ctx) return 0;
        const raw = ctx.read(this.definition.source);
        const value = typeof raw === 'number' ? raw : (raw ? 1 : 0);
        const { from, to } = this.definition;
        // Normalized then clamped, so `to < from` inverts rather than going negative.
        return clamp((value - from) / (to - from), 0, 1) * this.definition.bias;
    }

    public setGoal(): void {
        const current = this._think.currentSubgoal() as (AnyGoal & { definition?: GoalDefinition }) | null;
        // Re-planning an already-running goal would restart it every arbitration, which for a
        // composite means never getting past its first subgoal.
        if (current?.definition?.name === this.definition.goalName) return;

        const definition = this._host.byName.get(this.definition.goalName);
        if (!definition) return;
        this._think.clearSubgoals();
        this._think.addSubgoal(buildGoal(definition, this._host));
    }
}

/**
 * A running goal brain. Caller-owned, one per controller.
 *
 * A class rather than the record-plus-pure-function shape the rest of the control layer uses, because
 * it holds a live Yuka goal tree whose whole value is that it persists between frames.
 */
export class GoalBrain {
    private readonly _host: GoalOwner = { ctx: null, byName: new Map() };
    private readonly _think: Think<never>;
    private _interval: number = 0.5;
    private _sinceArbitration: number = 0;

    private constructor(graph: GoalGraph) {
        this._think = new (Think as unknown as new (owner?: unknown) => Think<never>)(this._host as never);
        this._interval = graph.arbitrationInterval;
        for (const goal of graph.goals) this._host.byName.set(goal.name, goal);
        for (const evaluator of graph.evaluators) {
            (this._think as unknown as { addEvaluator(e: unknown): unknown }).addEvaluator(
                new DataEvaluator(evaluator, this._think as never, this._host));
        }
    }

    public static from(graph: GoalGraph): GoalBrain {
        return new GoalBrain(graph);
    }

    /** Name of the goal currently being pursued at the top level, or ''. */
    public get current(): string {
        const goal = (this._think as unknown as {
            currentSubgoal(): { definition?: GoalDefinition } | null;
        }).currentSubgoal();
        return goal?.definition?.name ?? '';
    }

    /** The active plan, outermost first — for the editor readout and for `onThink`. */
    public get plan(): string[] {
        const out: string[] = [];
        let node: unknown = (this._think as unknown as {
            currentSubgoal(): unknown;
        }).currentSubgoal();
        let guard = 0;
        while (node && guard++ < 32) {
            const goal = node as { definition?: GoalDefinition; currentSubgoal?(): unknown };
            if (goal.definition) out.push(goal.definition.name);
            node = goal.currentSubgoal ? goal.currentSubgoal() : null;
        }
        return out;
    }

    /**
     * Advance the brain by one frame.
     *
     * A finished plan re-arbitrates immediately — that is Yuka's own `Think.execute`, which drops to
     * INACTIVE when its subgoal completes. The interval below is for ABANDONING a plan partway
     * because something better appeared, which is a different and much twitchier decision.
     */
    public step(ctx: GoalContext, dt: number): void {
        this._host.ctx = ctx;
        this._sinceArbitration += Number.isFinite(dt) && dt > 0 ? dt : 0;

        if (this._interval <= 0 || this._sinceArbitration >= this._interval) {
            this._sinceArbitration = 0;
            (this._think as unknown as { arbitrate(): unknown }).arbitrate();
        }
        (this._think as unknown as { execute(): unknown }).execute();
    }

    /** Abandon the current plan. For a respawned brain, which must not resume mid-plan. */
    public clear(): void {
        (this._think as unknown as { clearSubgoals(): unknown }).clearSubgoals();
        this._think.status = Goal.STATUS.INACTIVE;
        this._sinceArbitration = 0;
    }
}

/** Build a brain. Always succeeds; an empty graph simply decides nothing. */
export function buildGoalBrain(graph: GoalGraph): GoalBrain {
    return GoalBrain.from(graph);
}
