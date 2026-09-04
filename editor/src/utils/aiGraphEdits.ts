import type { FuzzyModel, FuzzyTermNode, GoalGraph } from 'cleo'

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
