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
 * ## Layers and outputs

A machine may have LAYERS beside its own states: each a machine of its own over the same parameters, running at
the same time (a Health layer going Fine → Hurt, a Weapon layer picking the gun), as an animator's layers do. Only
the top level steers. Any state, on any layer, may name OUTPUTS: fields of the pawn it sets while it is held (a
weapon to carry, a hurt flag for the animator), the topmost layer winning a field two states set. The caller
writes them (`ControllerNode`); here they are data.

## The one ordering rule
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
import { finiteOr } from "../math";

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
    // Group movement. Separation, alignment and cohesion over the other agents nearby -- the three
    // urges that turn a crowd into a shoal.
    'flock',
    // Sidestep round the target, square to the line to it and facing it, at a kept distance: a gunfight's
    // strafe. Which side is the state's (`strafeSide`); on `auto` it steps off the target's path.
    'strafe',
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
    /** Fields of the pawn this state sets while it is held (see {@link BehaviorOutput}). */
    outputs?: BehaviorOutput[];
    /**
     * A strafe's side: `auto` (the default) steps off the target's path, away from the way it is moving across
     * the line to it; `left` or `right` as the pawn faces the target.
     */
    strafeSide?: StrafeSide;
    /** A strafe's distance kept from the target (m): it closes in or backs off toward it as it steps. 0: any. */
    strafeDistance?: number;
    /** The state the machine starts in. Exactly one state should be the entry; the first wins otherwise. */
    isEntry?: boolean;
    /** Graph-editor layout coordinates. Authoring only — ignored at runtime, like AnimationState's. */
    x?: number;
    y?: number;
}

/** Which way a strafe steps. */
export const STRAFE_SIDES = ['auto', 'left', 'right'] as const;
export type StrafeSide = typeof STRAFE_SIDES[number];

/**
 * A field of the pawn a state sets: a script's field (`preferredWeapon`, `hurt`) or a node property, to `value`.
 * Held (the default), it is written every frame the state is held, and the field goes back to what it was once no
 * state outputs it any more; not held, it is written once as the state is entered and left as it is.
 */
export interface BehaviorOutput {
    field: string;
    value: number | boolean;
    hold?: boolean;
}

/** A machine running beside the top-level one over the same parameters: it never steers, only outputs. */
export interface BehaviorLayer {
    name: string;
    states: BehaviorState[];
    transitions: BehaviorTransition[];
    /** False: the layer is skipped (kept, not run). */
    enabled?: boolean;
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
    /**
     * May enter the state it leaves (from `*`, the state held): it starts over, its time back to 0. Another knock
     * while hurt starts the hurt over.
     */
    restart?: boolean;
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
    | { kind: 'sense'; name: BehaviorSense }
    /**
     * A defuzzified output of the controller's fuzzy model.
     *
     * The escape hatch from thresholds: "am I winning" is a blend of health, distance and how many
     * friends are left, and every way of writing that as `>` comparisons is a cliff somewhere.
     */
    | { kind: 'fuzzy'; name: string }
    /**
     * A value of the pawn's reactions (its body: knocked down, staggering, the last hit, how many knocks): the
     * animator's reaction parameters, by the same names (`REACTION_VALUES`). A counter (`knockCount`,
     * `hitCount`) read by a trigger raises it once each time it rises.
     */
    | { kind: 'reaction'; name: string }
    /** Seconds a layer has held its current state ('' or the layer's name; '' is the top level). */
    | { kind: 'layerTime'; layer: string }
    /** Whether a layer holds a state now. */
    | { kind: 'layerState'; layer: string; state: string };

export const BEHAVIOR_SENSES = [
    'distanceToTarget', 'angleToTarget', 'hasTarget', 'targetVisible', 'stateTime',
    // The ground-plane distance and the signed height difference. Melee and locomotion are planar --
    // a target on a ledge straight overhead is 0 m away for steering and 3 m away in a straight line,
    // and a machine banding on the straight line approaches forever, circling under it.
    'planarDistanceToTarget', 'heightToTarget',
    // Navigation. `pathRemaining` is the distance still to WALK, which is the question a machine
    // actually wants to ask -- `distanceToTarget` is a straight line and says a wall is one metre away
    // when the way round it is thirty.
    'hasPath', 'pathRemaining',
    // Perception. `targetVisible` (above) is a bare line-of-sight test kept for compatibility;
    // `targetInSight` is the one with a cone, a range and a reaction delay behind it.
    'targetInSight', 'timeSinceSeen', 'lastKnownDistance',
    // How many other agents are inside the flock radius. "Am I alone" is a question a machine wants
    // to ask, and it is the one thing about a group only the controller can answer.
    'neighborCount',
    // What is just ahead of the pawn, the way it faces: a wall it would walk into, a drop it would walk
    // off, and whether the target is in front of it at all. A platformer guard turns at both; a 3D one
    // asks them too. Probed on read.
    'wallAhead', 'ledgeAhead', 'targetInFront',
    // How the target moves: its speed, how fast it is coming at the pawn (negative going away), how fast across
    // the line to it (positive to the pawn's left as it faces the target), and whether it sits in a vehicle
    // (its velocity then the vehicle's).
    'targetSpeed', 'targetApproachSpeed', 'targetLateralSpeed', 'targetInVehicle',
] as const;
export type BehaviorSense = typeof BEHAVIOR_SENSES[number];

/** What each sense reads as, for a picker that offers it as a number or a yes/no. */
export const BEHAVIOR_SENSE_TYPES: Readonly<Record<BehaviorSense, 'number' | 'boolean'>> = {
    distanceToTarget: 'number', angleToTarget: 'number', hasTarget: 'boolean', targetVisible: 'boolean',
    stateTime: 'number', planarDistanceToTarget: 'number', heightToTarget: 'number', hasPath: 'boolean',
    pathRemaining: 'number', targetInSight: 'boolean', timeSinceSeen: 'number', lastKnownDistance: 'number',
    neighborCount: 'number', wallAhead: 'boolean', ledgeAhead: 'boolean', targetInFront: 'boolean',
    targetSpeed: 'number', targetApproachSpeed: 'number', targetLateralSpeed: 'number', targetInVehicle: 'boolean',
};

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
    /** Machines running beside this one over its parameters (see the module header). */
    layers?: BehaviorLayer[];
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
    /** Each layer's held state and its time in it, by layer name. */
    layers?: Record<string, { current: string; stateTime: number }>;
}

export function createBehaviorRuntime(): BehaviorRuntime {
    return { current: '', stateTime: 0, ctx: createConditionContext(), layers: {} };
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
    /** Each enabled layer's state now, and whether it was entered this frame, in the machine's order. */
    layers?: { name: string; state: BehaviorState | null; entered: boolean }[];
}

/** One machine's states and transitions: the top level's, or a layer's. */
interface StateTable { states: BehaviorState[]; transitions: BehaviorTransition[] }

/**
 * One table's step from `current` (held `stateTime`): the state it holds after, whether it entered it, and the
 * transition that fired (its triggers are the caller's to consume).
 */
function stepTable(table: StateTable, current: string, stateTime: number, ctx: ConditionContext): {
    state: BehaviorState | null; entered: boolean; current: string; stateTime: number; fired: BehaviorTransition | null;
} {
    if (table.states.length === 0) return { state: null, entered: false, current, stateTime, fired: null };
    const held = table.states.find(s => s.name === current) ?? null;
    if (!held) {
        const entry = table.states.find(s => s.isEntry) ?? table.states[0];
        return { state: entry, entered: true, current: entry.name, stateTime: 0, fired: null };
    }
    for (const t of table.transitions) {
        if (t.from !== '*' && t.from !== current) continue;
        if (t.to === current && !t.restart) continue;
        // Before the conditions, so a trigger is not consumed by a transition that cannot fire yet.
        if (t.minDwell && stateTime < t.minDwell) continue;
        // An absent condition is no constraint at all, matching an empty group.
        if (t.condition && !conditionNodeMet(ctx, t.condition)) continue;
        const target = table.states.find(s => s.name === t.to);
        if (!target) continue;
        return { state: target, entered: true, current: target.name, stateTime: 0, fired: t };
    }
    return { state: held, entered: false, current, stateTime, fired: null };
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
    const layers = (machine.layers ?? []).filter(l => l.enabled !== false);
    const next: BehaviorRuntime = {
        current: runtime.current,
        stateTime: runtime.stateTime + delta,
        ctx: runtime.ctx,
        layers: {},
    };
    const ran: { name: string; state: BehaviorState | null; entered: boolean }[] = [];

    if (machine.states.length === 0 && layers.length === 0) return { state: null, entered: false, next, layers: ran };

    // EVERY latch in the machine, every layer's too, before any transition is considered — see the module header.
    // Not on the frame the top level starts: nothing has been held yet to leave.
    const starting = !machine.states.some(s => s.name === next.current);
    if (!starting || layers.length > 0) {
        for (const t of machine.transitions) forEachCondition(t.condition, undefined, c => updateLatch(next.ctx, c));
        for (const l of layers) for (const t of l.transitions) forEachCondition(t.condition, undefined, c => updateLatch(next.ctx, c));
    }

    // The top level, then each layer, every one seeing the same triggers: a trigger is consumed once all have
    // looked, so a layer and the top level can both answer one.
    const fired: BehaviorTransition[] = [];
    const top = stepTable(machine, next.current, next.stateTime, next.ctx);
    next.current = top.current;
    next.stateTime = top.stateTime;
    if (top.fired) fired.push(top.fired);
    for (const l of layers) {
        const was = runtime.layers?.[l.name];
        const r = stepTable(l, was?.current ?? '', (was?.stateTime ?? 0) + (was ? delta : 0), next.ctx);
        next.layers![l.name] = { current: r.current, stateTime: r.stateTime };
        if (r.fired) fired.push(r.fired);
        ran.push({ name: l.name, state: r.state, entered: r.entered });
    }
    // EVERY trigger in each fired tree, including under an OR branch that did not contribute: one left raised
    // would fire some unrelated transition on the next frame.
    for (const t of fired) consumeTriggers(next.ctx, t.condition, undefined);
    return { state: top.state, entered: top.entered, next, layers: ran };
}

/** The state a layer holds ('' the top level), or null. */
export function behaviorLayerState(machine: BehaviorMachine, runtime: BehaviorRuntime, layer: string): BehaviorState | null {
    if (!layer) return stateNamed(machine, runtime.current);
    const l = machine.layers?.find(x => x.name === layer);
    const held = runtime.layers?.[layer]?.current;
    return l && held ? l.states.find(s => s.name === held) ?? null : null;
}

// ---------------------------------------------------------------------------------------------------
// Tolerant reader
// ---------------------------------------------------------------------------------------------------

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
        case 'fuzzy': {
            const name = str(s.name);
            return name ? { kind: 'fuzzy', name } : { kind: 'const', value: 0 };
        }
        case 'reaction': {
            const name = str(s.name);
            return name ? { kind: 'reaction', name } : { kind: 'const', value: 0 };
        }
        case 'layerTime':
            return { kind: 'layerTime', layer: str(s.layer) };
        case 'layerState': {
            const state = str(s.state);
            return state ? { kind: 'layerState', layer: str(s.layer), state } : { kind: 'const', value: false };
        }
        default:
            return { kind: 'const', value: typeof s.value === 'boolean' ? s.value : finiteOr(s.value, 0) };
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
        default: type === 'number' ? finiteOr(p.default, 0) : p.default === true,
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
    const speedScale = finiteOr(s.speedScale, 1);
    if (speedScale !== 1) out.speedScale = Math.max(0, Math.min(1, speedScale));
    if (s.isEntry === true) out.isEntry = true;
    if (typeof s.x === 'number' && Number.isFinite(s.x)) out.x = s.x;
    if (typeof s.y === 'number' && Number.isFinite(s.y)) out.y = s.y;
    const outputs: BehaviorOutput[] = [];
    for (const raw of (Array.isArray(s.outputs) ? s.outputs : [])) {
        const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const field = str(o.field);
        if (!field || outputs.some(x => x.field === field)) continue;
        const value = typeof o.value === 'boolean' ? o.value : finiteOr(o.value, 0);
        outputs.push(o.hold === false ? { field, value, hold: false } : { field, value });
    }
    if (outputs.length) out.outputs = outputs;
    if (s.strafeSide === 'left' || s.strafeSide === 'right') out.strafeSide = s.strafeSide;
    const keep = finiteOr(s.strafeDistance, 0);
    if (keep > 0) out.strafeDistance = keep;
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
    const minDwell = finiteOr(t.minDwell, 0);
    if (minDwell > 0) out.minDwell = minDwell;
    if (t.restart === true) out.restart = true;
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

    const transitions = parseTransitions(m.transitions, stateNames);

    const layers: BehaviorLayer[] = [];
    for (const entry of (Array.isArray(m.layers) ? m.layers : [])) {
        if (!entry || typeof entry !== 'object') continue;
        const l = entry as Record<string, unknown>;
        const name = str(l.name);
        if (!name || layers.some(x => x.name === name)) continue;
        const ls: BehaviorState[] = [];
        const names = new Set<string>();
        for (const raw of (Array.isArray(l.states) ? l.states : [])) {
            const state = parseBehaviorState(raw);
            if (!state || names.has(state.name)) continue;
            names.add(state.name);
            ls.push(state);
        }
        const layer: BehaviorLayer = { name, states: ls, transitions: parseTransitions(l.transitions, names) };
        if (l.enabled === false) layer.enabled = false;
        layers.push(layer);
    }

    return layers.length ? { parameters, states, transitions, layers } : { parameters, states, transitions };
}

/** Transitions read, those naming no state of their table dropped (they can never fire). */
function parseTransitions(raw: unknown, stateNames: Set<string>): BehaviorTransition[] {
    const transitions: BehaviorTransition[] = [];
    for (const entry of (Array.isArray(raw) ? raw : [])) {
        const transition = parseBehaviorTransition(entry);
        if (!transition) continue;
        if (transition.from !== '*' && !stateNames.has(transition.from)) continue;
        if (!stateNames.has(transition.to)) continue;
        transitions.push(transition);
    }
    return transitions;
}

/** Whether a machine is empty, so a controller that never authored one serializes nothing. */
export function isDefaultBehaviorMachine(machine: unknown): boolean {
    const parsed = parseBehaviorMachine(machine);
    return parsed.parameters.length === 0 && parsed.states.length === 0 && parsed.transitions.length === 0 && !parsed.layers?.length;
}
