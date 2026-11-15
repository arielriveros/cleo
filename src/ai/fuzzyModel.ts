// What a fuzzy model IS, as data: its sets, variables and rules, the tolerant reader that brings a saved one up to
// date, and the defaults. The engine's core keeps it (a controller round-trips its model without the AI feature);
// building and running a model (ai/fuzzy.ts, on yuka) is the AI feature's.
import { clamp, finiteOr } from "../core/math";

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
    /** Canvas position in the Fuzzy editor. Authoring only; see `GoalDefinition.x`. */
    x?: number;
    y?: number;
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
    /**
     * Canvas position in the Fuzzy editor.
     *
     * A rule is a NODE on that canvas, not an edge, because it is a hyper-edge: several antecedent
     * variables feed one consequent, and a pairwise link cannot say that. So it needs a position of
     * its own like any other node.
     */
    x?: number;
    y?: number;
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

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

export function parseFuzzySet(raw: unknown): FuzzySetDefinition | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    const name = str(s.name);
    if (!name) return null;

    const left = finiteOr(s.left, 0);
    const right = finiteOr(s.right, left + 1);
    return {
        name,
        shape: (FUZZY_SET_SHAPES as readonly string[]).includes(s.shape as string)
            ? s.shape as FuzzySetShape : 'triangular',
        left,
        // Clamped INTO the span: a midpoint outside its own set makes every membership zero, which
        // reads as a rule that never fires and is invisible from the outside.
        mid: clamp(finiteOr(s.mid, (left + right) / 2), Math.min(left, right), Math.max(left, right)),
        right,
        ...(typeof s.deviation === 'number' && isFinite(s.deviation) && s.deviation > 0
            ? { deviation: s.deviation } : {}),
    };
}

/**
 * Canvas coordinates, kept only when BOTH are present and finite.
 *
 * Half a coordinate is not a position: writing one back would pin the node to x = 0 forever, which
 * looks like the editor losing a layout rather than like a malformed field being ignored.
 */
function coords(raw: Record<string, unknown>): { x: number; y: number } | null {
    return typeof raw.x === 'number' && Number.isFinite(raw.x) &&
           typeof raw.y === 'number' && Number.isFinite(raw.y)
        ? { x: raw.x, y: raw.y } : null;
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
    return sets.length > 0 ? { name, sets, ...(coords(v) ?? {}) } : null;
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
    return antecedent && variable && set
        ? { antecedent, variable, set, ...(coords(r) ?? {}) } : null;
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

