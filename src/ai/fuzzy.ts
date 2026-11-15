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

import { clamp, finiteOr } from "../core/math";
import {
    FuzzyAND, FuzzyFAIRLY, FuzzyModule, FuzzyOR, FuzzyRule, FuzzyVariable, FuzzyVERY,
    LeftSCurveFuzzySet, LeftShoulderFuzzySet, NormalDistFuzzySet, RightSCurveFuzzySet,
    RightShoulderFuzzySet, SingletonFuzzySet, TriangularFuzzySet,
} from "./yuka";
import type { FuzzySet, FuzzyTerm } from "./yuka";
import { type FuzzySetDefinition, type FuzzyTermNode, type Defuzzification, type FuzzyModel } from './fuzzyModel';
// The data half (parsing, defaults) lives in ./fuzzyModel, which the engine's core reads without this module.
export * from './fuzzyModel';

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
