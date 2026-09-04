import { describe, it, expect } from 'vitest'
import { parseFuzzyModel, parseGoalGraph } from 'cleo'
import {
  flattenAndTerm, renameFuzzySet, renameFuzzyVariable, renameGoal, termUsesVariable,
} from '../src/utils/aiGraphEdits'

// Both AI graphs address things BY NAME on more than one side, and both are read back through a
// TOLERANT reader that silently drops anything dangling. So a rename that forgets one side does not
// error -- it quietly deletes the author's work, and the only sign is a goal that can never be chosen
// or a fuzzy rule that has vanished from the list.
//
// Every test here re-parses the result, because passing the reader is the actual requirement: an
// in-memory object that looks right but is dropped on load has not been renamed correctly.

const GRAPH = parseGoalGraph({
  arbitrationInterval: 0.5,
  goals: [
    { name: 'Attack', goal: 'idle', subgoals: ['Approach', 'Strike'] },
    { name: 'Approach', goal: 'seek' },
    { name: 'Strike', goal: 'idle' },
  ],
  evaluators: [
    { goalName: 'Attack', source: { kind: 'const', value: 1 }, from: 0, to: 1, bias: 1 },
    { goalName: 'Approach', source: { kind: 'const', value: 1 }, from: 0, to: 1, bias: 1 },
  ],
})

describe('renameGoal', () => {
  it('carries the evaluators that name it', () => {
    const renamed = parseGoalGraph(renameGoal(GRAPH, 'Attack', 'Assault'))
    expect(renamed.goals.map(g => g.name)).toContain('Assault')
    // Without this the evaluator is dropped on read and the goal can never be chosen again.
    expect(renamed.evaluators.map(e => e.goalName)).toContain('Assault')
    expect(renamed.evaluators).toHaveLength(2)
  })

  it('carries the subgoal lists that name it', () => {
    const renamed = parseGoalGraph(renameGoal(GRAPH, 'Approach', 'CloseIn'))
    expect(renamed.goals.find(g => g.name === 'Attack')!.subgoals).toEqual(['CloseIn', 'Strike'])
    // And the whole plan survives the reader rather than losing its first step.
    expect(renamed.goals.find(g => g.name === 'CloseIn')).toBeTruthy()
  })

  it('leaves everything else alone', () => {
    const renamed = renameGoal(GRAPH, 'Strike', 'Hit')
    expect(renamed.goals.find(g => g.name === 'Approach')).toBeTruthy()
    expect(renamed.arbitrationInterval).toBe(0.5)
  })

  it('is a no-op when the name is unchanged', () => {
    expect(renameGoal(GRAPH, 'Attack', 'Attack')).toBe(GRAPH)
  })
})

const MODEL = parseFuzzyModel({
  variables: [
    {
      name: 'distance',
      sets: [
        { name: 'near', shape: 'leftShoulder', left: 0, mid: 3, right: 20 },
        { name: 'far', shape: 'rightShoulder', left: 3, mid: 20, right: 40 },
      ],
    },
    {
      name: 'commitment',
      sets: [
        { name: 'low', shape: 'leftShoulder', left: 0, mid: 10, right: 50 },
        // Deliberately shares a set name with `distance` having none: renaming must be per variable.
        { name: 'high', shape: 'rightShoulder', left: 50, mid: 90, right: 100 },
      ],
    },
  ],
  rules: [
    { antecedent: { op: 'is', variable: 'distance', set: 'near' }, variable: 'commitment', set: 'high' },
    { antecedent: { op: 'is', variable: 'distance', set: 'far' }, variable: 'commitment', set: 'low' },
  ],
  defuzzification: 'maxav',
})

describe('renameFuzzyVariable', () => {
  it('carries rules that READ it', () => {
    const renamed = parseFuzzyModel(renameFuzzyVariable(MODEL, 'distance', 'range'))
    expect(renamed.variables.map(v => v.name)).toContain('range')
    // Both rules survive the reader; forgetting the antecedent would drop them entirely.
    expect(renamed.rules).toHaveLength(2)
    expect(renamed.rules.every(r => (r.antecedent as { variable: string }).variable === 'range')).toBe(true)
  })

  it('carries rules that WRITE it', () => {
    const renamed = parseFuzzyModel(renameFuzzyVariable(MODEL, 'commitment', 'resolve'))
    expect(renamed.rules).toHaveLength(2)
    expect(renamed.rules.every(r => r.variable === 'resolve')).toBe(true)
  })

  it('rewrites nested antecedents', () => {
    const nested = parseFuzzyModel({
      variables: MODEL.variables,
      rules: [{
        antecedent: {
          op: 'and',
          children: [
            { op: 'is', variable: 'distance', set: 'near' },
            { op: 'very', child: { op: 'is', variable: 'distance', set: 'far' } },
          ],
        },
        variable: 'commitment', set: 'high',
      }],
    })
    const renamed = parseFuzzyModel(renameFuzzyVariable(nested, 'distance', 'range'))
    expect(renamed.rules).toHaveLength(1)
    expect(termUsesVariable(renamed.rules[0].antecedent, 'range')).toBe(true)
    expect(termUsesVariable(renamed.rules[0].antecedent, 'distance')).toBe(false)
  })

  it('is a no-op when the name is unchanged', () => {
    expect(renameFuzzyVariable(MODEL, 'distance', 'distance')).toBe(MODEL)
  })
})

describe('renameFuzzySet', () => {
  it('carries the antecedent terms that name it', () => {
    const renamed = parseFuzzyModel(renameFuzzySet(MODEL, 'distance', 'near', 'close'))
    expect(renamed.rules).toHaveLength(2)
    expect((renamed.rules[0].antecedent as { set: string }).set).toBe('close')
  })

  it('carries the consequent when the rule writes that variable', () => {
    const renamed = parseFuzzyModel(renameFuzzySet(MODEL, 'commitment', 'high', 'total'))
    expect(renamed.rules).toHaveLength(2)
    expect(renamed.rules[0].set).toBe('total')
  })

  // Two variables may each have a set called "high"; renaming one must not touch the other.
  it('does not touch a same-named set on a different variable', () => {
    const shared = parseFuzzyModel({
      variables: [
        { name: 'a', sets: [{ name: 'high', shape: 'triangular', left: 0, mid: 1, right: 2 }] },
        { name: 'b', sets: [{ name: 'high', shape: 'triangular', left: 0, mid: 1, right: 2 }] },
      ],
      rules: [{ antecedent: { op: 'is', variable: 'a', set: 'high' }, variable: 'b', set: 'high' }],
    })
    const renamed = parseFuzzyModel(renameFuzzySet(shared, 'a', 'high', 'tall'))

    expect(renamed.variables.find(v => v.name === 'a')!.sets[0].name).toBe('tall')
    expect(renamed.variables.find(v => v.name === 'b')!.sets[0].name).toBe('high')
    expect((renamed.rules[0].antecedent as { set: string }).set).toBe('tall')
    expect(renamed.rules[0].set).toBe('high')
  })
})

describe('flattenAndTerm', () => {
  it('reads a single term and a plain AND chain', () => {
    expect(flattenAndTerm({ op: 'is', variable: 'a', set: 's' })).toHaveLength(1)
    expect(flattenAndTerm({
      op: 'and',
      children: [
        { op: 'is', variable: 'a', set: 's' },
        { op: 'is', variable: 'b', set: 't' },
      ],
    })).toHaveLength(2)
  })

  // Refusing is the point: the row says it cannot show the rule rather than silently flattening
  // structure the engine supports and the author wrote.
  it('refuses anything richer, rather than discarding it', () => {
    expect(flattenAndTerm({
      op: 'or',
      children: [{ op: 'is', variable: 'a', set: 's' }, { op: 'is', variable: 'b', set: 't' }],
    })).toBeNull()
    expect(flattenAndTerm({
      op: 'and',
      children: [
        { op: 'is', variable: 'a', set: 's' },
        { op: 'very', child: { op: 'is', variable: 'b', set: 't' } },
      ],
    })).toBeNull()
    expect(flattenAndTerm({ op: 'very', child: { op: 'is', variable: 'a', set: 's' } })).toBeNull()
  })
})
