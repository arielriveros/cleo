import type {
    BehaviorLayer, BehaviorMachine, BehaviorParameter, BehaviorTransition, ConditionNode, FuzzyModel, FuzzyTermNode, GoalGraph,
} from 'cleo'

/**
 * Renames inside the AI graphs, as pure functions.
 *
 * These live outside their components because they are the part most likely to be wrong and the only
 * part worth testing. Both graphs address things BY NAME on more than one side, and both are read
 * back through a TOLERANT reader that silently drops anything dangling — so a rename that forgets one
 * side does not error, it quietly deletes the author's work:
 *
 *  - renaming a goal and forgetting its evaluators drops every desirability for it, and the goal can
 *    then never be chosen;
 *  - forgetting the subgoal lists drops it out of whatever plan contained it;
 *  - renaming a fuzzy variable and forgetting the rules drops every rule that mentions it, on either
 *    the antecedent or the consequent side.
 *
 * Each one is "rewrite every reference in the same pass that rewrites the definition".
 */

/** Rename a goal, carrying its evaluators and every subgoal list that names it. */
export function renameGoal(graph: GoalGraph, from: string, to: string): GoalGraph {
    if (from === to) return graph
    return {
        ...graph,
        goals: graph.goals.map(goal => ({
            ...goal,
            name: goal.name === from ? to : goal.name,
            subgoals: goal.subgoals?.map(s => (s === from ? to : s)),
        })),
        evaluators: graph.evaluators.map(e => (e.goalName === from ? { ...e, goalName: to } : e)),
    }
}

/** Rename a fuzzy variable, carrying every rule that reads or writes it. */
export function renameFuzzyVariable(model: FuzzyModel, from: string, to: string): FuzzyModel {
    if (from === to) return model
    return {
        ...model,
        variables: model.variables.map(v => (v.name === from ? { ...v, name: to } : v)),
        rules: model.rules.map(r => ({
            ...r,
            variable: r.variable === from ? to : r.variable,
            antecedent: renameVariableInTerm(r.antecedent, from, to),
        })),
    }
}

/** Rename one set of one variable, carrying every rule term that names it. */
export function renameFuzzySet(
    model: FuzzyModel, variable: string, from: string, to: string,
): FuzzyModel {
    if (from === to) return model
    return {
        ...model,
        variables: model.variables.map(v => (v.name === variable
            ? { ...v, sets: v.sets.map(s => (s.name === from ? { ...s, name: to } : s)) }
            : v)),
        rules: model.rules.map(r => ({
            ...r,
            // Only when the consequent names THIS variable: two variables may each have a set called
            // "high", and renaming one must not touch the other.
            set: r.variable === variable && r.set === from ? to : r.set,
            antecedent: renameSetInTerm(r.antecedent, variable, from, to),
        })),
    }
}

// Switched on `op` rather than chained ifs: the union narrows cleanly that way, and the hedge and the
// gate variants carry different property names.

export function renameVariableInTerm(term: FuzzyTermNode, from: string, to: string): FuzzyTermNode {
    switch (term.op) {
        case 'is': return term.variable === from ? { ...term, variable: to } : term
        case 'and':
        case 'or': return { ...term, children: term.children.map(c => renameVariableInTerm(c, from, to)) }
        default: return { ...term, child: renameVariableInTerm(term.child, from, to) }
    }
}

export function renameSetInTerm(
    term: FuzzyTermNode, variable: string, from: string, to: string,
): FuzzyTermNode {
    switch (term.op) {
        case 'is':
            return term.variable === variable && term.set === from ? { ...term, set: to } : term
        case 'and':
        case 'or':
            return { ...term, children: term.children.map(c => renameSetInTerm(c, variable, from, to)) }
        default:
            return { ...term, child: renameSetInTerm(term.child, variable, from, to) }
    }
}

/** Whether a term reads a variable anywhere in its tree. */
export function termUsesVariable(term: FuzzyTermNode, variable: string): boolean {
    switch (term.op) {
        case 'is': return term.variable === variable
        case 'and':
        case 'or': return term.children.some(c => termUsesVariable(c, variable))
        default: return termUsesVariable(term.child, variable)
    }
}

/**
 * The `is` leaves of a plain AND chain, or null when the tree is anything richer.
 *
 * The rule editor shows a flat "A is x AND B is y" row. A model authored elsewhere with OR or a hedge
 * is left alone rather than silently flattened — returning null is what lets the row say so instead of
 * discarding structure the engine supports.
 */
export function flattenAndTerm(
    term: FuzzyTermNode,
): { op: 'is'; variable: string; set: string }[] | null {
    if (term.op === 'is') return [term]
    if (term.op !== 'and') return null
    const out: { op: 'is'; variable: string; set: string }[] = []
    for (const child of term.children) {
        if (child.op !== 'is') return null
        out.push(child)
    }
    return out
}

/**
 * A pair of states and whichever directions exist between them.
 *
 * The graph draws one line per PAIR, not per transition: A to B and B to A are the same line, doubled.
 * That matches how an author thinks about two states and is what lets one edge carry both gates.
 *
 * Ordered so the pair key is stable regardless of which transition was authored first — otherwise the
 * same link would produce two different edge ids depending on insertion order, and selection would
 * stop matching after a reload.
 */
export interface BehaviorLink {
    a: string
    b: string
    forward?: BehaviorTransition
    backward?: BehaviorTransition
}

/** Sorted pair key, so a link has one identity whichever direction is asked about. */
export function behaviorLinkKey(x: string, y: string): [string, string] {
    return x <= y ? [x, y] : [y, x]
}

/**
 * Collapse a machine's transitions into links.
 *
 * A wildcard transition (`from: '*'`) has no source node to draw from, so it is skipped rather than
 * given a phantom endpoint — it still runs, and the list editor is where it is visible.
 */
export function behaviorLinks(machine: BehaviorMachine): BehaviorLink[] {
    const byKey = new Map<string, BehaviorLink>()
    for (const t of machine.transitions) {
        if (t.from === '*') continue
        const [a, b] = behaviorLinkKey(t.from, t.to)
        const key = a + '|' + b
        let link = byKey.get(key)
        if (!link) {
            link = { a, b }
            byKey.set(key, link)
        }
        if (t.from === a) link.forward = t
        else link.backward = t
    }
    return [...byKey.values()]
}

/** Whether a machine has any transition that the graph cannot draw. */
export function hasWildcardTransitions(machine: BehaviorMachine): boolean {
    return machine.transitions.some(t => t.from === '*')
}

// ---- behaviour machines: names that other things refer to ----
//
// A behaviour machine names its states in its transitions (from, to), and a brain's parameters name them too: a
// Layer state source reads "is layer L in state S", a Layer time source reads layer L. Conditions name parameters.
// The tolerant reader drops a transition whose state is gone, and a source whose state is gone silently reads false
// forever: every rename and removal below rewrites the references in the same pass.

/** What is wrong with a name for a state, a parameter or a layer, or null when it is fine. */
export function behaviorNameProblem(name: string, taken: readonly string[], what: 'state' | 'parameter' | 'layer'): string | null {
    const n = name.trim()
    if (!n) return `A ${what} needs a name.`
    if (n === '*') return '"*" stands for any state.'
    if (taken.includes(n)) return `Another ${what} is called "${n}".`
    return null
}

type States = BehaviorMachine['states']

/** The machine `layer` names ('' the top level), and how to put an edited one back. */
function machineOf(m: BehaviorMachine, layer: string): { states: States; transitions: BehaviorTransition[]; put: (states: States, transitions: BehaviorTransition[]) => BehaviorMachine } | null {
    if (!layer) return { states: m.states, transitions: m.transitions, put: (states, transitions) => ({ ...m, states, transitions }) }
    const l = m.layers?.find(x => x.name === layer)
    if (!l) return null
    return {
        states: l.states, transitions: l.transitions,
        put: (states, transitions) => ({ ...m, layers: m.layers!.map(x => (x === l ? { ...x, states, transitions } : x)) }),
    }
}

const mapParams = (m: BehaviorMachine, f: (p: BehaviorParameter) => BehaviorParameter): BehaviorParameter[] => m.parameters.map(f)

/**
 * Rename a state of the top-level machine (`layer` '') or of a layer: its transitions follow (a wildcard `*` is
 * never one), and so does every Layer state source reading it.
 */
export function renameBehaviorState(m: BehaviorMachine, layer: string, from: string, to: string): BehaviorMachine {
    if (from === to) return m
    const at = machineOf(m, layer)
    if (!at) return m
    const next = at.put(
        at.states.map(s => (s.name === from ? { ...s, name: to } : s)),
        at.transitions.map(t => ({ ...t, from: t.from === from ? to : t.from, to: t.to === from ? to : t.to })),
    )
    return {
        ...next,
        parameters: mapParams(next, p => (p.source.kind === 'layerState' && p.source.layer === layer && p.source.state === from
            ? { ...p, source: { ...p.source, state: to } } : p)),
    }
}

/** Remove a state, every transition touching it, and point a Layer state source reading it at a constant false. */
export function removeBehaviorState(m: BehaviorMachine, layer: string, name: string): BehaviorMachine {
    const at = machineOf(m, layer)
    if (!at) return m
    const next = at.put(at.states.filter(s => s.name !== name), at.transitions.filter(t => t.from !== name && t.to !== name))
    return {
        ...next,
        parameters: mapParams(next, p => (p.source.kind === 'layerState' && p.source.layer === layer && p.source.state === name
            ? { ...p, source: { kind: 'const', value: false } } : p)),
    }
}

/** A condition tree with every leaf reading `from` reading `to`. */
export function renameParamInCondition<T extends ConditionNode>(node: T, from: string, to: string): T {
    if ('children' in node) return { ...node, children: node.children.map(c => renameParamInCondition(c, from, to)) }
    return node.param === from ? { ...node, param: to } : node
}

const renameInTransitions = (ts: BehaviorTransition[], from: string, to: string): BehaviorTransition[] =>
    ts.map(t => (t.condition ? { ...t, condition: renameParamInCondition(t.condition, from, to) } : t))

/** Rename a parameter, carrying every condition that reads it: the top level's and every layer's. */
export function renameBehaviorParameter(m: BehaviorMachine, from: string, to: string): BehaviorMachine {
    if (from === to) return m
    return {
        ...m,
        parameters: m.parameters.map(p => (p.name === from ? { ...p, name: to } : p)),
        transitions: renameInTransitions(m.transitions, from, to),
        ...(m.layers ? { layers: m.layers.map(l => ({ ...l, transitions: renameInTransitions(l.transitions, from, to) })) } : {}),
    }
}

/** Rename a layer, carrying the Layer time and Layer state sources that read it. */
export function renameBehaviorLayer(m: BehaviorMachine, from: string, to: string): BehaviorMachine {
    if (from === to || !m.layers?.some(l => l.name === from)) return m
    return {
        ...m,
        layers: m.layers.map(l => (l.name === from ? { ...l, name: to } : l)),
        parameters: mapParams(m, p => ((p.source.kind === 'layerTime' || p.source.kind === 'layerState') && p.source.layer === from
            ? { ...p, source: { ...p.source, layer: to } } : p)),
    }
}

/**
 * Remove a layer. A source reading it reads a constant (false for its state, 0 for its time) rather than keep a
 * dangling name: a later layer of the same name would quietly take it over.
 */
export function removeBehaviorLayer(m: BehaviorMachine, name: string): BehaviorMachine {
    const layers: BehaviorLayer[] = (m.layers ?? []).filter(l => l.name !== name)
    const next: BehaviorMachine = {
        ...m,
        parameters: mapParams(m, p => (p.source.kind === 'layerState' && p.source.layer === name ? { ...p, source: { kind: 'const', value: false } }
            : p.source.kind === 'layerTime' && p.source.layer === name ? { ...p, source: { kind: 'const', value: 0 } } : p)),
    }
    if (layers.length) next.layers = layers
    else delete next.layers
    return next
}
