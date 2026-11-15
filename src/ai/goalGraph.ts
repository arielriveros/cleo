// What a goal graph IS, as data: its goals and desirability evaluators, the tolerant reader and the defaults. The
// engine's core keeps it (a controller round-trips its graph without the AI feature); running one (ai/goals.ts, on
// yuka) is the AI feature's.
import { clamp, finiteOr } from "../core/math";
import type { AiGoal, BehaviorParameterSource } from "../core/control/behavior";
import type { ConditionGroup } from "../core/conditions";

/**
 * One thing an agent can be trying to do.
 *
 * A goal with `subgoals` is COMPOSITE: it runs them in order and finishes when the last one does. A
 * goal without them is a leaf that drives a steering verb.
 */
export interface GoalDefinition {
    name: string;
    /** The steering verb a leaf drives. Ignored for a composite, whose leaves drive their own. */
    goal: AiGoal;
    /** Blackboard key naming this goal's target. Falls back to the controller's own when absent. */
    targetKey?: string;
    /** Throttle, 0..1. */
    speedScale?: number;
    /** Names of subgoals, in execution order. Present makes this a composite. */
    subgoals?: string[];
    /** Completed once this is met. Absent means it runs until arbitration replaces it. */
    until?: ConditionGroup;
    /** Failed once this is met — which pops it and lets its parent replan. */
    failWhen?: ConditionGroup;
    /**
     * Canvas position in the Goals editor. Authoring only — nothing at runtime reads these.
     *
     * Stored on the goal rather than in a side table so a duplicated controller keeps its layout, the
     * same arrangement `BehaviorState` already uses. Absent means "never placed", and the editor
     * auto-lays-out from the goal's index instead.
     */
    x?: number;
    y?: number;
}

/**
 * How much an agent wants a goal, as a curve over one readable value.
 *
 * Deliberately one source and a range rather than an expression language. The value that decides
 * "should I chase" is nearly always a single number — a distance, a time since seen, a fuzzy output —
 * and the moment it is not, `{ kind: 'fuzzy' }` is the escape hatch that already exists and is built
 * for combining several.
 */
export interface DesirabilityDefinition {
    goalName: string;
    source: BehaviorParameterSource;
    /** Value mapping to desirability 0. */
    from: number;
    /** Value mapping to desirability 1. `to < from` inverts, which is how "nearer is better" reads. */
    to: number;
    /** Multiplier on the result — Yuka's `characterBias`. A timid agent scales its fight goal down. */
    bias: number;
}

export interface GoalGraph {
    goals: GoalDefinition[];
    evaluators: DesirabilityDefinition[];
    /**
     * Seconds between re-arbitrations. 0 reconsiders every frame.
     *
     * A plan that finishes always re-arbitrates immediately regardless; this is about ABANDONING a
     * plan partway because something better appeared. Every frame is rarely wanted: it makes an agent
     * that flickers between two nearly-equal goals, which is the goal-driven version of a state
     * machine ping-ponging on a threshold.
     */
    arbitrationInterval: number;
}

export const EMPTY_GOAL_GRAPH: GoalGraph = { goals: [], evaluators: [], arbitrationInterval: 0.5 };

/** What a goal needs from the world. Supplied by whoever owns the brain. */
export interface GoalContext {
    /** Read a parameter source — the same vocabulary the behaviour machine uses. */
    read(source: BehaviorParameterSource): number | boolean;
    /** Whether a condition tree is currently met. */
    met(condition: ConditionGroup | undefined): boolean;
    /** Drive the steering layer for this frame. Called by whichever leaf goal is active. */
    drive(goal: AiGoal, targetKey: string | undefined, speedScale: number): void;
}

// ---------------------------------------------------------------------------------------------------
// Tolerant reader
// ---------------------------------------------------------------------------------------------------

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

export function parseGoalDefinition(raw: unknown): GoalDefinition | null {
    if (!raw || typeof raw !== 'object') return null;
    const g = raw as Record<string, unknown>;
    const name = str(g.name);
    if (!name) return null;

    const out: GoalDefinition = { name, goal: str(g.goal) as AiGoal };
    const targetKey = str(g.targetKey);
    if (targetKey) out.targetKey = targetKey;
    const speedScale = finiteOr(g.speedScale, 1);
    if (speedScale !== 1) out.speedScale = clamp(speedScale, 0, 1);

    const subgoals: string[] = [];
    for (const entry of (Array.isArray(g.subgoals) ? g.subgoals : [])) {
        const child = str(entry);
        // A goal listing itself is a plan that nests forever.
        if (child && child !== name && !subgoals.includes(child)) subgoals.push(child);
    }
    if (subgoals.length > 0) out.subgoals = subgoals;

    if (g.until && typeof g.until === 'object') out.until = g.until as ConditionGroup;
    if (g.failWhen && typeof g.failWhen === 'object') out.failWhen = g.failWhen as ConditionGroup;

    // Kept only when both are present and finite: half a coordinate is not a position, and writing a
    // partial one back would pin the goal to x = 0 forever.
    if (typeof g.x === 'number' && Number.isFinite(g.x) &&
        typeof g.y === 'number' && Number.isFinite(g.y)) {
        out.x = g.x;
        out.y = g.y;
    }
    return out;
}

export function parseDesirability(raw: unknown): DesirabilityDefinition | null {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as Record<string, unknown>;
    const goalName = str(e.goalName);
    if (!goalName) return null;

    const source = (e.source && typeof e.source === 'object')
        ? e.source as BehaviorParameterSource
        : { kind: 'const', value: 1 } as BehaviorParameterSource;
    const from = finiteOr(e.from, 0);
    return {
        goalName,
        source,
        from,
        // Never equal to `from`: a zero-width range divides by zero, and the honest reading of
        // "0 maps to 0 and 0 maps to 1" is a step, which `to = from + epsilon` already gives.
        to: finiteOr(e.to, from + 1) === from ? from + 1e-6 : finiteOr(e.to, from + 1),
        bias: Math.max(0, finiteOr(e.bias, 1)),
    };
}

/**
 * Read a whole graph. Entries that could never run are dropped:
 *
 *  - a subgoal naming a goal that does not exist,
 *  - a goal whose subgoals form a CYCLE (a plan that nests forever),
 *  - an evaluator naming a goal that does not exist, which would arbitrate to nothing.
 */
export function parseGoalGraph(raw: unknown): GoalGraph {
    if (!raw || typeof raw !== 'object') return { ...EMPTY_GOAL_GRAPH };
    const g = raw as Record<string, unknown>;

    const goals: GoalDefinition[] = [];
    const names = new Set<string>();
    for (const entry of (Array.isArray(g.goals) ? g.goals : [])) {
        const goal = parseGoalDefinition(entry);
        if (!goal || names.has(goal.name)) continue;
        names.add(goal.name);
        goals.push(goal);
    }

    // Drop subgoal references to goals that do not exist, then drop goals still caught in a cycle.
    for (const goal of goals) {
        if (!goal.subgoals) continue;
        goal.subgoals = goal.subgoals.filter(name => names.has(name));
        if (goal.subgoals.length === 0) delete goal.subgoals;
    }
    // Collected against the ORIGINAL graph before anything is deleted. Deleting as we go would make
    // the result depend on iteration order: breaking A -> B also breaks the B -> A cycle, so B would
    // keep its subgoal purely because it was checked second.
    const byName = new Map(goals.map(goal => [goal.name, goal]));
    const cyclic = new Set<string>();
    for (const goal of goals) {
        if (goal.subgoals && isCyclic(goal.name, byName, new Set())) cyclic.add(goal.name);
    }
    for (const goal of goals) {
        if (cyclic.has(goal.name)) delete goal.subgoals;
    }

    const evaluators: DesirabilityDefinition[] = [];
    for (const entry of (Array.isArray(g.evaluators) ? g.evaluators : [])) {
        const evaluator = parseDesirability(entry);
        if (evaluator && names.has(evaluator.goalName)) evaluators.push(evaluator);
    }

    return {
        goals,
        evaluators,
        arbitrationInterval: Math.max(0, finiteOr(g.arbitrationInterval, EMPTY_GOAL_GRAPH.arbitrationInterval)),
    };
}

function isCyclic(name: string, byName: Map<string, GoalDefinition>, seen: Set<string>): boolean {
    if (seen.has(name)) return true;
    seen.add(name);
    const goal = byName.get(name);
    for (const child of goal?.subgoals ?? []) {
        if (isCyclic(child, byName, new Set(seen))) return true;
    }
    return false;
}

/** Whether a graph would decide anything, so an untouched block serializes nothing. */
export function isDefaultGoalGraph(graph: unknown): boolean {
    const parsed = parseGoalGraph(graph);
    return parsed.goals.length === 0 && parsed.evaluators.length === 0;
}

