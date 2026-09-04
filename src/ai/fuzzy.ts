/**
 * Fuzzy decisions, as authored data.
 *
 * The question fuzzy logic answers is the one a threshold answers badly: "how much do I want to do
 * this, given several things that are each a matter of degree?" A guard at 9.9 metres and one at 10.1
 * metres are not in different worlds, but `distance < 10` says they are. A fuzzy rule set turns
 * several such gradients into one number, and does it in a way an author can read back.
 *
 * Wraps Yuka's `FuzzyModule`, `FuzzyVariable`, `FuzzyRule` and its seven set shapes. A LEAF: no Node,
 * no scene, no physics. Everything is defaulted through a tolerant reader, so a partial or stale
 * authored block loads as a model that simply decides less rather than a scene that will not open.
 *
 * ## The one thing that will bite you
 *
 * **`FuzzyVariable.fuzzify` neither throws nor clamps on an input outside the variable's range — it
 * logs a warning and returns, leaving the PREVIOUS call's degrees of membership in place.** So the
 * next `defuzzify` answers the previous question.
 *
 * Measured on a 0..400 "distance" variable: `fuzzify(350)` then defuzzify gave 87.50; `fuzzify(-50)` —
 * which should read as *close* and give about 12.5 — **also returned 87.50**, silently. Out-of-domain
 * input does not degrade toward a neutral answer, it returns the previous answer, which can be the
 * exact opposite of correct. Every input here is therefore clamped to `[minRange, maxRange]` before it
 * reaches Yuka, and there is a test that fails if that clamp is removed.
 *
 * ## Shapes
 *
 * Every set is `(left, midpoint, right)`. `left` and `right` are where membership reaches zero and
 * `midpoint` where it peaks — except for the shoulders, which stay at 1 beyond their midpoint
 * (`leftShoulder` toward -infinity, `rightShoulder` toward +infinity), which is what makes the ends of
 * a variable's range behave. `normal` adds a standard deviation.
 *
 * A variable's RANGE is the union of its sets' `left`..`right`; Yuka computes it as sets are added, so
 * a value outside every set is outside the variable.
 */

import { clamp } from "../core/math";
import {
    FuzzyAND, FuzzyFAIRLY, FuzzyModule, FuzzyOR, FuzzyRule, FuzzyVariable, FuzzyVERY,
    LeftSCurveFuzzySet, LeftShoulderFuzzySet, NormalDistFuzzySet, RightSCurveFuzzySet,
    RightShoulderFuzzySet, SingletonFuzzySet, TriangularFuzzySet,
} from "./yuka";
import type { FuzzySet, FuzzyTerm } from "./yuka";

export const FUZZY_SET_SHAPES = [
    'triangular', 'leftShoulder', 'rightShoulder', 'leftSCurve', 'rightSCurve', 'normal', 'singleton',
] as const;
export type FuzzySetShape = typeof FUZZY_SET_SHAPES[number];

export interface FuzzySetDefinition {
    name: string;
    shape: FuzzySetShape;
    /** Where membership reaches zero on the way up. */
    left: number;
    /** Where membership peaks. */
    mid: number;
    /** Where membership reaches zero on the way down. */
    right: number;
    /** `normal` only. Defaults to a quarter of the span, which gives a curve that fits its own set. */
    deviation?: number;
}

export interface FuzzyVariableDefinition {
    name: string;
    sets: FuzzySetDefinition[];
}

/**
 * An antecedent, as a tree.
 *
 * `very` squares a membership (concentration) and `fairly` takes its square root (dilation) — the
 * classic linguistic hedges, and the reason a rule can say "very close" without a second set.
 */
export type FuzzyTermNode =
    | { op: 'is'; variable: string; set: string }
    | { op: 'and' | 'or'; children: FuzzyTermNode[] }
    | { op: 'very' | 'fairly'; child: FuzzyTermNode };

export interface FuzzyRuleDefinition {
    antecedent: FuzzyTermNode;
    /** The consequent: this variable takes this set, to the degree the antecedent fired. */
    variable: string;
    set: string;
}

export const DEFUZZIFICATIONS = ['maxav', 'centroid'] as const;
export type Defuzzification = typeof DEFUZZIFICATIONS[number];

export interface FuzzyModel {
    variables: FuzzyVariableDefinition[];
    rules: FuzzyRuleDefinition[];
    /**
     * `maxav` takes the average of each set's peak weighted by its firing strength — cheap, and
     * jumpier. `centroid` integrates the whole output surface — smoother, and about 20x the work.
     */
    defuzzification: Defuzzification;
}

export const EMPTY_FUZZY_MODEL: FuzzyModel = { variables: [], rules: [], defuzzification: 'maxav' };

// ---------------------------------------------------------------------------------------------------
// Tolerant reader
// ---------------------------------------------------------------------------------------------------

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

export function parseFuzzySet(raw: unknown): FuzzySetDefinition | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    const name = str(s.name);
    if (!name) return null;

    const left = num(s.left, 0);
    const right = num(s.right, left + 1);
    return {
        name,
        shape: (FUZZY_SET_SHAPES as readonly string[]).includes(s.shape as string)
            ? s.shape as FuzzySetShape : 'triangular',
        left,
        // Clamped INTO the span: a midpoint outside its own set makes every membership zero, which
        // reads as a rule that never fires and is invisible from the outside.
        mid: clamp(num(s.mid, (left + right) / 2), Math.min(left, right), Math.max(left, right)),
        right,
        ...(typeof s.deviation === 'number' && isFinite(s.deviation) && s.deviation > 0
            ? { deviation: s.deviation } : {}),
    };
}

export function parseFuzzyVariable(raw: unknown): FuzzyVariableDefinition | null {
    if (!raw || typeof raw !== 'object') return null;
    const v = raw as Record<string, unknown>;
    const name = str(v.name);
    if (!name) return null;

    const sets: FuzzySetDefinition[] = [];
    const seen = new Set<string>();
    for (const entry of (Array.isArray(v.sets) ? v.sets : [])) {
        const set = parseFuzzySet(entry);
        // A duplicate name would shadow the first, and a rule naming it could not say which it meant.
        if (!set || seen.has(set.name)) continue;
        seen.add(set.name);
        sets.push(set);
    }
    // A variable with no sets has an empty range, so every fuzzify against it is out of range.
    return sets.length > 0 ? { name, sets } : null;
}

export function parseFuzzyTerm(raw: unknown): FuzzyTermNode | null {
    if (!raw || typeof raw !== 'object') return null;
    const t = raw as Record<string, unknown>;
    switch (t.op) {
        case 'and':
        case 'or': {
            const children: FuzzyTermNode[] = [];
            for (const child of (Array.isArray(t.children) ? t.children : [])) {
                const parsed = parseFuzzyTerm(child);
                if (parsed) children.push(parsed);
            }
            // Yuka's AND/OR need at least two terms to mean anything; one collapses to itself.
            if (children.length === 0) return null;
            if (children.length === 1) return children[0];
            return { op: t.op, children };
        }
        case 'very':
        case 'fairly': {
            const child = parseFuzzyTerm(t.child);
            return child ? { op: t.op, child } : null;
        }
        default: {
            const variable = str(t.variable);
            const set = str(t.set);
            return variable && set ? { op: 'is', variable, set } : null;
        }
    }
}

export function parseFuzzyRule(raw: unknown): FuzzyRuleDefinition | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const antecedent = parseFuzzyTerm(r.antecedent);
    const variable = str(r.variable);
    const set = str(r.set);
    return antecedent && variable && set ? { antecedent, variable, set } : null;
}

/** Read a whole model from anything. Unreadable entries are dropped; siblings keep their order. */
export function parseFuzzyModel(raw: unknown): FuzzyModel {
    if (!raw || typeof raw !== 'object') return { ...EMPTY_FUZZY_MODEL };
    const m = raw as Record<string, unknown>;

    const variables: FuzzyVariableDefinition[] = [];
    const names = new Set<string>();
    for (const entry of (Array.isArray(m.variables) ? m.variables : [])) {
        const variable = parseFuzzyVariable(entry);
        if (!variable || names.has(variable.name)) continue;
        names.add(variable.name);
        variables.push(variable);
    }

    const rules: FuzzyRuleDefinition[] = [];
    for (const entry of (Array.isArray(m.rules) ? m.rules : [])) {
        const rule = parseFuzzyRule(entry);
        // A rule naming a variable or set that does not exist can never fire, and leaving it would
        // show a row in the editor that does nothing.
        if (rule && resolvableAgainst(variables, rule)) rules.push(rule);
    }

    return {
        variables,
        rules,
        defuzzification: (DEFUZZIFICATIONS as readonly string[]).includes(m.defuzzification as string)
            ? m.defuzzification as Defuzzification : 'maxav',
    };
}

function hasSet(variables: readonly FuzzyVariableDefinition[], variable: string, set: string): boolean {
    return variables.some(v => v.name === variable && v.sets.some(s => s.name === set));
}

function termResolves(variables: readonly FuzzyVariableDefinition[], term: FuzzyTermNode): boolean {
    switch (term.op) {
        case 'is': return hasSet(variables, term.variable, term.set);
        case 'and':
        case 'or': return term.children.every(c => termResolves(variables, c));
        default: return termResolves(variables, term.child);
    }
}

function resolvableAgainst(variables: readonly FuzzyVariableDefinition[], rule: FuzzyRuleDefinition): boolean {
    return hasSet(variables, rule.variable, rule.set) && termResolves(variables, rule.antecedent);
}

/** Whether a model would decide anything, so an untouched block serializes nothing. */
export function isDefaultFuzzyModel(model: unknown): boolean {
    const parsed = parseFuzzyModel(model);
    return parsed.variables.length === 0 && parsed.rules.length === 0;
}

// ---------------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------------

function buildSet(definition: FuzzySetDefinition): FuzzySet {
    const { left, mid, right } = definition;
    switch (definition.shape) {
        case 'leftShoulder': return new LeftShoulderFuzzySet(left, mid, right);
        case 'rightShoulder': return new RightShoulderFuzzySet(left, mid, right);
        case 'leftSCurve': return new LeftSCurveFuzzySet(left, mid, right);
        case 'rightSCurve': return new RightSCurveFuzzySet(left, mid, right);
        case 'singleton': return new SingletonFuzzySet(left, mid, right);
        case 'normal':
            // A quarter of the span is a curve that fits inside its own set; Yuka's default of 1 is a
            // world-units number masquerading as a shape parameter.
            return new NormalDistFuzzySet(left, mid, right,
                definition.deviation ?? Math.max(1e-6, (right - left) / 4));
        default: return new TriangularFuzzySet(left, mid, right);
    }
}

/**
 * A built fuzzy model, ready to answer questions.
 *
 * Holds the Yuka module plus the range of every variable, because the range is what the mandatory
 * input clamp is measured against — see the module header.
 */
export class FuzzyBrain {
    private readonly _module = new FuzzyModule();
    private readonly _ranges = new Map<string, { min: number; max: number }>();
    private readonly _outputs = new Set<string>();
    private readonly _inputs = new Set<string>();
    private _defuzzification: Defuzzification = 'maxav';

    public static from(model: FuzzyModel): FuzzyBrain {
        const brain = new FuzzyBrain();
        brain._load(model);
        return brain;
    }

    private _load(model: FuzzyModel): void {
        this._defuzzification = model.defuzzification;

        // Every set, keyed so a rule can resolve one by name.
        const sets = new Map<string, FuzzySet>();
        for (const definition of model.variables) {
            const variable = new FuzzyVariable();
            for (const setDefinition of definition.sets) {
                const set = buildSet(setDefinition);
                variable.add(set);
                sets.set(definition.name + '.' + setDefinition.name, set);
            }
            this._module.addFLV(definition.name, variable);
            this._ranges.set(definition.name, { min: variable.minRange, max: variable.maxRange });
        }

        for (const rule of model.rules) {
            const antecedent = this._buildTerm(rule.antecedent, sets);
            const consequence = sets.get(rule.variable + '.' + rule.set);
            if (!antecedent || !consequence) continue;
            this._module.addRule(new FuzzyRule(antecedent, consequence));
            // Derived rather than authored: an output list that could disagree with the rules is a
            // second source of truth for no gain.
            this._outputs.add(rule.variable);
            this._collectInputs(rule.antecedent);
        }
    }

    private _buildTerm(node: FuzzyTermNode, sets: Map<string, FuzzySet>): FuzzyTerm | null {
        switch (node.op) {
            case 'is':
                return sets.get(node.variable + '.' + node.set) ?? null;
            case 'and':
            case 'or': {
                const children: FuzzyTerm[] = [];
                for (const child of node.children) {
                    const term = this._buildTerm(child, sets);
                    if (!term) return null;
                    children.push(term);
                }
                return node.op === 'and' ? new FuzzyAND(...children) : new FuzzyOR(...children);
            }
            default: {
                const child = this._buildTerm(node.child, sets);
                if (!child) return null;
                return node.op === 'very' ? new FuzzyVERY(child) : new FuzzyFAIRLY(child);
            }
        }
    }

    private _collectInputs(node: FuzzyTermNode): void {
        switch (node.op) {
            case 'is': this._inputs.add(node.variable); break;
            case 'and':
            case 'or': for (const child of node.children) this._collectInputs(child); break;
            default: this._collectInputs(node.child);
        }
    }

    /** Variables that rules read. What a caller has to supply. */
    public get inputs(): string[] { return [...this._inputs]; }

    /** Variables that rules write. What a caller can ask for. */
    public get outputs(): string[] { return [...this._outputs]; }

    public get ruleCount(): number { return this._module.rules.length; }

    /** The authored range of a variable, or null if there is no such variable. */
    public rangeOf(name: string): { min: number; max: number } | null {
        return this._ranges.get(name) ?? null;
    }

    /**
     * Set one input, CLAMPED into its variable's range.
     *
     * The clamp is the whole reason this method exists rather than a direct `fuzzify` — see the
     * module header for what an unclamped out-of-range value does.
     */
    public set(name: string, value: number): boolean {
        const range = this._ranges.get(name);
        if (!range) return false;
        const safe = Number.isFinite(value) ? clamp(value, range.min, range.max) : range.min;
        this._module.fuzzify(name, safe);
        return true;
    }

    /** Defuzzify one output. 0 for a variable nothing writes, which is a neutral answer. */
    public get(name: string): number {
        if (!this._outputs.has(name)) return 0;
        const type = this._defuzzification === 'centroid'
            ? FuzzyModule.DEFUZ_TYPE.CENTROID
            : FuzzyModule.DEFUZ_TYPE.MAXAV;
        const value = this._module.defuzzify(name, type);
        // Yuka returns NaN when no rule fired at all -- a division by a zero confidence sum. Zero is
        // the honest answer for "nothing had an opinion".
        return Number.isFinite(value) ? value : 0;
    }

    /** Set every input and read every output, in one call. */
    public evaluate(inputs: Readonly<Record<string, number>>): Record<string, number> {
        for (const name of this._inputs) {
            const value = inputs[name];
            if (typeof value === 'number') this.set(name, value);
        }
        const out: Record<string, number> = {};
        for (const name of this._outputs) out[name] = this.get(name);
        return out;
    }
}

/** Build a model. Always succeeds; an empty model simply decides nothing. */
export function buildFuzzyModule(model: FuzzyModel): FuzzyBrain {
    return FuzzyBrain.from(model);
}
