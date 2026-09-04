/**
 * A behaviour state machine: patrol → chase → attack, as authored data rather than as a script.
 *
 * The steering goals in `steering.ts` answer "how do I move toward that"; this answers "what am I trying
 * to do right now, and when does that change". A state names a goal; a transition names the condition
 * that leaves it.
 *
 * ## Why this is small
 *
 * It reuses `core/conditions.ts` wholesale — the same model, evaluator and hysteresis latching the
 * animation state machine has used for as long as it has existed, and the same editor UI. What is left
 * here is a state table, a transition walk and a tolerant reader. Had any of that had to be built from
 * scratch, `onThink` plus a steering goal would have been the better answer and this file would not
 * exist; the whole case for it is that the parts were already there.
 *
 * A LEAF beyond `conditions.ts`: no Node, no scene, no physics. The parameter VALUES are filled in by the
 * caller — `ControllerNode` reads them off the possessed pawn's measured motion, the blackboard and its
 * own senses — so everything here is a pure function of the table and the values.
 *
 * ## The one ordering rule
 *
 * Latches for EVERY condition in the machine advance once per frame, before any transition is
 * considered — not just the ones leaving the current state. A `>`/`<` hysteresis pair almost always sits
 * on two different states, and a band that only advanced while its own state was current would leave
 * both halves latched on. This is the same rule `Animator._evaluateStateMachine` follows, and for the
 * same reason.
 */

import {
    conditionNodeMet, consumeTriggers, createConditionContext, forEachCondition, parseConditionNode,
    updateLatch,
} from "../conditions";
import type { ConditionContext, ConditionGroup, ConditionNode } from "../conditions";

/**
 * What a state is trying to do. Shared with `ControllerNode.goal` — a state simply sets it, so a machine
 * with one state is exactly equivalent to setting the goal by hand.
 */
export const AI_GOALS = [
    'idle', 'seek', 'flee', 'arrive', 'follow', 'wander',
    // Navigation goals. `path` walks a route around geometry to wherever `seek` would have gone in a
    // straight line; `patrol` walks a route authored on the navmesh. Both fall back to their
    // straight-line equivalent when the scene has no baked navmesh, so adding one is never a
    // regression on a scene that has not baked yet.
    'path', 'patrol',
    // Perception. `investigate` walks to where a target was LAST SEEN -- the behaviour the whole
    // memory system exists to enable, and the difference between an agent that loses you and one that
    // comes looking.
    'investigate',
    'script',
] as const;
export type AiGoal = typeof AI_GOALS[number];

export interface BehaviorState {
    name: string;
    goal: AiGoal;
    /** Blackboard key naming this state's target. Falls back to the controller's own when absent. */
    targetKey?: string;
    /** Throttle for this state, 0..1. A patrol at 0.4 and a chase at 1 with no other difference. */
    speedScale?: number;
    /** The state the machine starts in. Exactly one state should be the entry; the first wins otherwise. */
    isEntry?: boolean;
    /** Graph-editor layout coordinates. Authoring only — ignored at runtime, like AnimationState's. */
    x?: number;
    y?: number;
}

export interface BehaviorTransition {
    /** Source state name, or '*' to match any state. */
    from: string;
    to: string;
    condition?: ConditionGroup;
    /**
     * Seconds the machine must have spent in `from` before this may fire. The guard against a
     * ping-ponging pair — real seconds since entry, and checked BEFORE the conditions so a trigger is
     * not consumed by a transition that cannot fire yet.
     */
    minDwell?: number;
}

/**
 * Where a parameter's value comes from. The controller fills these in; the machine only reads names.
 *
 * `builtin` deliberately reuses the animator's `NODE_BUILTINS` vocabulary rather than inventing a second
 * measured-motion surface — `planarSpeed`, `isGrounded`, `stillTime`, `slopeAngle` and the rest are
 * already measured off the pawn's physics body, and duplicating them would let the two drift.
 */
export type BehaviorParameterSource =
    | { kind: 'const'; value: number | boolean }
    | { kind: 'builtin'; name: string }
    | { kind: 'variable'; varName: string }
    | { kind: 'blackboard'; key: string }
    /** The few things only the controller knows, because they are about the goal rather than the pawn. */
    | { kind: 'sense'; name: BehaviorSense };

export const BEHAVIOR_SENSES = [
    'distanceToTarget', 'angleToTarget', 'hasTarget', 'targetVisible', 'stateTime',
    // Navigation. `pathRemaining` is the distance still to WALK, which is the question a machine
    // actually wants to ask -- `distanceToTarget` is a straight line and says a wall is one metre away
    // when the way round it is thirty.
    'hasPath', 'pathRemaining',
    // Perception. `targetVisible` (above) is a bare line-of-sight test kept for compatibility;
    // `targetInSight` is the one with a cone, a range and a reaction delay behind it.
    'targetInSight', 'timeSinceSeen', 'lastKnownDistance',
] as const;
export type BehaviorSense = typeof BEHAVIOR_SENSES[number];

export const BEHAVIOR_PARAM_TYPES = ['number', 'boolean', 'trigger'] as const;
export type BehaviorParameterType = typeof BEHAVIOR_PARAM_TYPES[number];

export interface BehaviorParameter {
    name: string;
    type: BehaviorParameterType;
    default: number | boolean;
    source: BehaviorParameterSource;
}

export interface BehaviorMachine {
    parameters: BehaviorParameter[];
    states: BehaviorState[];
    transitions: BehaviorTransition[];
}

/** An empty machine. A controller with one falls back to its own `goal` field. */
export const EMPTY_BEHAVIOR: BehaviorMachine = { parameters: [], states: [], transitions: [] };

export interface BehaviorRuntime {
    /** Name of the state currently held, or '' before the machine has entered one. */
    current: string;
    /** Seconds spent in it. Feeds `minDwell` and the `stateTime` sense. */
    stateTime: number;
    /** Parameter values and hysteresis latches. The caller fills `values` each frame. */
    ctx: ConditionContext;
}

export function createBehaviorRuntime(): BehaviorRuntime {
    return { current: '', stateTime: 0, ctx: createConditionContext() };
}

/** The state a machine starts in: the one flagged, else the first. */
export function entryState(machine: BehaviorMachine): BehaviorState | null {
    return machine.states.find(s => s.isEntry) ?? machine.states[0] ?? null;
}

export function stateNamed(machine: BehaviorMachine, name: string): BehaviorState | null {
    return machine.states.find(s => s.name === name) ?? null;
}

export interface BehaviorStep {
    /** The state now held, or null for an empty machine. */
    state: BehaviorState | null;
    /** True on exactly the frame the machine entered this state. */
    entered: boolean;
    next: BehaviorRuntime;
}

/**
 * Advance the machine by one frame.
 *
 * `runtime.ctx.values` must already hold this frame's parameter values — filling them is the caller's
 * job, because only the caller knows what a pawn's `planarSpeed` is. Everything from there down is a
 * pure function of the table and those values.
 */
export function stepBehavior(
    machine: BehaviorMachine, runtime: BehaviorRuntime, dt: number,
): BehaviorStep {
    const delta = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const next: BehaviorRuntime = {
        current: runtime.current,
        stateTime: runtime.stateTime + delta,
        ctx: runtime.ctx,
    };

    if (machine.states.length === 0) return { state: null, entered: false, next };

    // Enter, if the machine has not started or is holding a state that no longer exists (an author
    // deleted it while playing). Falling back to the entry beats holding a name nothing answers to.
    let current = stateNamed(machine, next.current);
    if (!current) {
        current = entryState(machine);
        next.current = current?.name ?? '';
        next.stateTime = 0;
        return { state: current, entered: true, next };
    }

    // EVERY latch in the machine, before any transition is considered — see the module header.
    for (const t of machine.transitions)
        forEachCondition(t.condition, undefined, c => updateLatch(next.ctx, c));

    for (const t of machine.transitions) {
        if (t.from !== '*' && t.from !== next.current) continue;
        if (t.to === next.current) continue;
        // Before the conditions, so a trigger is not consumed by a transition that cannot fire yet.
        if (t.minDwell && next.stateTime < t.minDwell) continue;
        // An absent condition is no constraint at all, matching an empty group.
        if (t.condition && !conditionNodeMet(next.ctx, t.condition)) continue;

        const target = stateNamed(machine, t.to);
        if (!target) continue;

        // EVERY trigger in the tree, including under an OR branch that did not contribute: one left
        // raised would fire some unrelated transition on the next frame.
        consumeTriggers(next.ctx, t.condition, undefined);
        next.current = target.name;
        next.stateTime = 0;
        return { state: target, entered: true, next };
    }

    return { state: current, entered: false, next };
}

// ---------------------------------------------------------------------------------------------------
// Tolerant reader
// ---------------------------------------------------------------------------------------------------

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function parseSource(raw: unknown): BehaviorParameterSource {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    switch (s.kind) {
        case 'builtin': {
            const name = str(s.name);
            return name ? { kind: 'builtin', name } : { kind: 'const', value: 0 };
        }
        case 'variable': {
            const varName = str(s.varName);
            return varName ? { kind: 'variable', varName } : { kind: 'const', value: 0 };
        }
        case 'blackboard': {
            const key = str(s.key);
            return key ? { kind: 'blackboard', key } : { kind: 'const', value: 0 };
        }
        case 'sense': {
            const name = str(s.name);
            return (BEHAVIOR_SENSES as readonly string[]).includes(name)
                ? { kind: 'sense', name: name as BehaviorSense }
                : { kind: 'const', value: 0 };
        }
        default:
            return { kind: 'const', value: typeof s.value === 'boolean' ? s.value : num(s.value, 0) };
    }
}

export function parseBehaviorParameter(raw: unknown): BehaviorParameter | null {
    if (!raw || typeof raw !== 'object') return null;
    const p = raw as Record<string, unknown>;
    const name = str(p.name);
    if (!name) return null;
    const type = (BEHAVIOR_PARAM_TYPES as readonly string[]).includes(p.type as string)
        ? p.type as BehaviorParameterType : 'number';
    return {
        name,
        type,
        default: type === 'number' ? num(p.default, 0) : p.default === true,
        source: parseSource(p.source),
    };
}

export function parseBehaviorState(raw: unknown): BehaviorState | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    const name = str(s.name);
    if (!name) return null;
    const out: BehaviorState = {
        name,
        goal: (AI_GOALS as readonly string[]).includes(s.goal as string) ? s.goal as AiGoal : 'idle',
    };
    const targetKey = str(s.targetKey);
    if (targetKey) out.targetKey = targetKey;
    // Written only when it differs from full throttle, so an untouched state serializes no field.
    const speedScale = num(s.speedScale, 1);
    if (speedScale !== 1) out.speedScale = Math.max(0, Math.min(1, speedScale));
    if (s.isEntry === true) out.isEntry = true;
    if (typeof s.x === 'number' && Number.isFinite(s.x)) out.x = s.x;
    if (typeof s.y === 'number' && Number.isFinite(s.y)) out.y = s.y;
    return out;
}

export function parseBehaviorTransition(raw: unknown): BehaviorTransition | null {
    if (!raw || typeof raw !== 'object') return null;
    const t = raw as Record<string, unknown>;
    const from = str(t.from);
    const to = str(t.to);
    if (!from || !to) return null;
    const out: BehaviorTransition = { from, to };
    const condition = parseConditionNode(t.condition);
    // Only a GROUP can gate a transition; a bare leaf is wrapped so the editor always has a root to
    // append to, which is the shape ConditionTree expects.
    if (condition) out.condition = 'children' in condition
        ? condition
        : { op: 'and', children: [condition as ConditionNode] };
    const minDwell = num(t.minDwell, 0);
    if (minDwell > 0) out.minDwell = minDwell;
    return out;
}

/**
 * Read a whole machine from anything. Unreadable entries are dropped while their siblings keep order,
 * and a transition naming a state that does not exist is dropped too — it can never fire, and leaving it
 * would show a row in the editor that does nothing.
 */
export function parseBehaviorMachine(raw: unknown): BehaviorMachine {
    if (!raw || typeof raw !== 'object') return { parameters: [], states: [], transitions: [] };
    const m = raw as Record<string, unknown>;

    const parameters: BehaviorParameter[] = [];
    const paramNames = new Set<string>();
    for (const entry of (Array.isArray(m.parameters) ? m.parameters : [])) {
        const parameter = parseBehaviorParameter(entry);
        if (!parameter || paramNames.has(parameter.name)) continue;
        paramNames.add(parameter.name);
        parameters.push(parameter);
    }

    const states: BehaviorState[] = [];
    const stateNames = new Set<string>();
    for (const entry of (Array.isArray(m.states) ? m.states : [])) {
        const state = parseBehaviorState(entry);
        if (!state || stateNames.has(state.name)) continue;
        stateNames.add(state.name);
        states.push(state);
    }

    const transitions: BehaviorTransition[] = [];
    for (const entry of (Array.isArray(m.transitions) ? m.transitions : [])) {
        const transition = parseBehaviorTransition(entry);
        if (!transition) continue;
        if (transition.from !== '*' && !stateNames.has(transition.from)) continue;
        if (!stateNames.has(transition.to)) continue;
        transitions.push(transition);
    }

    return { parameters, states, transitions };
}

/** Whether a machine is empty, so a controller that never authored one serializes nothing. */
export function isDefaultBehaviorMachine(machine: unknown): boolean {
    const parsed = parseBehaviorMachine(machine);
    return parsed.parameters.length === 0 && parsed.states.length === 0 && parsed.transitions.length === 0;
}
