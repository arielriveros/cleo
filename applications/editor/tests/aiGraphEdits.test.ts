import { describe, it, expect } from 'vitest'
import { parseBehaviorMachine, parseFuzzyModel, parseGoalGraph } from 'cleo'
import {
  behaviorLinkKey, behaviorLinks, behaviorNameProblem, flattenAndTerm, hasWildcardTransitions, removeBehaviorLayer,
  removeBehaviorState, renameBehaviorLayer, renameBehaviorParameter, renameBehaviorState, renameFuzzySet,
  renameFuzzyVariable, renameGoal, termUsesVariable,
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

// The graph draws one line per PAIR of states, not one per transition, so the collapse has to be
// order-independent: the same two states must produce the same link identity whichever transition was
// authored first, or selection stops matching after a reload.
describe('behaviorLinks', () => {
  const machine = (transitions: unknown[]) => parseBehaviorMachine({
    parameters: [],
    states: [{ name: 'A', goal: 'idle', isEntry: true }, { name: 'B', goal: 'seek' }],
    transitions,
  })

  it('collapses both directions onto one link', () => {
    const links = behaviorLinks(machine([{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }]))
    expect(links).toHaveLength(1)
    expect(links[0].forward).toBeTruthy()
    expect(links[0].backward).toBeTruthy()
  })

  it('gives the same link identity whichever direction was authored first', () => {
    const forwardFirst = behaviorLinks(machine([{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }]))
    const backwardFirst = behaviorLinks(machine([{ from: 'B', to: 'A' }, { from: 'A', to: 'B' }]))
    expect(forwardFirst[0].a).toBe(backwardFirst[0].a)
    expect(forwardFirst[0].b).toBe(backwardFirst[0].b)
  })

  it('keeps a one-way link one-way', () => {
    const links = behaviorLinks(machine([{ from: 'A', to: 'B' }]))
    expect(links).toHaveLength(1)
    expect(!!links[0].forward !== !!links[0].backward).toBe(true)
  })

  // A wildcard has no source node to draw from. Skipping it is right; skipping it SILENTLY is not,
  // which is why the toolbar counts them.
  it('skips a wildcard transition and reports that there is one', () => {
    const m = machine([{ from: '*', to: 'B' }, { from: 'A', to: 'B' }])
    expect(behaviorLinks(m)).toHaveLength(1)
    expect(hasWildcardTransitions(m)).toBe(true)
    expect(hasWildcardTransitions(machine([{ from: 'A', to: 'B' }]))).toBe(false)
  })

  it('sorts a pair key regardless of argument order', () => {
    expect(behaviorLinkKey('B', 'A')).toEqual(['A', 'B'])
    expect(behaviorLinkKey('A', 'B')).toEqual(['A', 'B'])
  })

  it('has nothing to draw for a machine with no transitions', () => {
    expect(behaviorLinks(machine([]))).toHaveLength(0)
  })
})

// A brain's behaviour machine names its states in transitions (top level and every layer), names them again in its
// parameters' Layer state sources, and names parameters in every condition. The Sandbox's Enemy Brain: a Health
// layer whose Hurt state the Weapon layer reads through "Is Hurt" (Pistol while hurt).
const BRAIN = parseBehaviorMachine({
  parameters: [
    { name: 'Knock', type: 'trigger', default: false, source: { kind: 'reaction', name: 'knockCount' } },
    { name: 'Hurt For', type: 'number', default: 0, source: { kind: 'layerTime', layer: 'Health' } },
    { name: 'Is Hurt', type: 'boolean', default: false, source: { kind: 'layerState', layer: 'Health', state: 'Hurt' } },
    { name: 'Patrolling', type: 'boolean', default: false, source: { kind: 'layerState', layer: '', state: 'patrol' } },
    { name: 'Distance', type: 'number', default: 0, source: { kind: 'sense', name: 'distanceToTarget' } },
  ],
  states: [{ name: 'patrol', goal: 'idle', isEntry: true }, { name: 'Hurt', goal: 'idle' }],
  transitions: [{ from: 'patrol', to: 'Hurt', condition: { op: 'and', children: [{ param: 'Distance', op: 'lt', value: 3 }] } }],
  layers: [
    {
      name: 'Health',
      states: [{ name: 'Fine', goal: 'idle', isEntry: true }, { name: 'Hurt', goal: 'idle', outputs: [{ field: 'hurt', value: true }] }],
      transitions: [
        { from: '*', to: 'Hurt', restart: true, condition: { op: 'and', children: [{ param: 'Knock', op: 'trigger' }] } },
        { from: 'Hurt', to: 'Fine', condition: { op: 'and', children: [{ param: 'Hurt For', op: 'gt', value: 12 }] } },
      ],
    },
    {
      name: 'Weapon',
      states: [{ name: 'Rifle', goal: 'idle', isEntry: true }, { name: 'Pistol', goal: 'idle' }],
      transitions: [
        { from: '*', to: 'Pistol', condition: { op: 'and', children: [{ param: 'Is Hurt', op: 'true' }] } },
        { from: 'Pistol', to: 'Rifle', condition: { op: 'or', children: [{ op: 'and', children: [{ param: 'Is Hurt', op: 'false' }, { param: 'Distance', op: 'gt', value: 4 }] }] } },
      ],
    },
  ],
})

describe('behaviour machine renames', () => {
  it("renames a layer's state, carrying its transitions and the Layer state sources reading it, nothing else", () => {
    const m = parseBehaviorMachine(renameBehaviorState(BRAIN, 'Health', 'Hurt', 'Hurting'))
    const health = m.layers!.find(l => l.name === 'Health')!
    expect(health.states.map(s => s.name)).toEqual(['Fine', 'Hurting'])
    // Its outputs ride on the state.
    expect(health.states[1].outputs).toEqual([{ field: 'hurt', value: true }])
    expect(health.transitions.map(t => `${t.from}>${t.to}`)).toEqual(['*>Hurting', 'Hurting>Fine'])
    expect(m.parameters.find(p => p.name === 'Is Hurt')!.source).toEqual({ kind: 'layerState', layer: 'Health', state: 'Hurting' })
    // The top level's own Hurt state is another state: untouched.
    expect(m.states.map(s => s.name)).toEqual(['patrol', 'Hurt'])
    expect(m.transitions.map(t => `${t.from}>${t.to}`)).toEqual(['patrol>Hurt'])
  })

  it('renames a top-level state with its Base Layer state sources; a layer state of the same name is left', () => {
    const m = parseBehaviorMachine(renameBehaviorState(BRAIN, '', 'patrol', 'walk'))
    expect(m.states.map(s => s.name)).toEqual(['walk', 'Hurt'])
    expect(m.transitions[0].from).toBe('walk')
    expect(m.parameters.find(p => p.name === 'Patrolling')!.source).toEqual({ kind: 'layerState', layer: '', state: 'walk' })
    const other = parseBehaviorMachine(renameBehaviorState(BRAIN, '', 'Hurt', 'Down'))
    expect(other.parameters.find(p => p.name === 'Is Hurt')!.source).toEqual({ kind: 'layerState', layer: 'Health', state: 'Hurt' })
    expect(other.layers![0].states[1].name).toBe('Hurt')
  })

  it('renames a parameter in every condition, nested, on the top level and in every layer', () => {
    const m = parseBehaviorMachine(renameBehaviorParameter(BRAIN, 'Is Hurt', 'Wounded'))
    const weapon = m.layers!.find(l => l.name === 'Weapon')!
    expect(JSON.stringify(weapon.transitions)).not.toContain('Is Hurt')
    expect(JSON.stringify(weapon.transitions).match(/Wounded/g)).toHaveLength(2)
    const d = parseBehaviorMachine(renameBehaviorParameter(BRAIN, 'Distance', 'Range'))
    expect(JSON.stringify(d)).not.toContain('"Distance"')
    expect(d.transitions[0].condition).toEqual({ op: 'and', children: [{ param: 'Range', op: 'lt', value: 3 }] })
    expect(JSON.stringify(d.layers![1].transitions)).toContain('Range')
  })

  it('renames a layer with its sources, and removing a layer or a state points their sources at constants', () => {
    const r = parseBehaviorMachine(renameBehaviorLayer(BRAIN, 'Health', 'Body'))
    expect(r.parameters.find(p => p.name === 'Hurt For')!.source).toEqual({ kind: 'layerTime', layer: 'Body' })
    expect(r.parameters.find(p => p.name === 'Is Hurt')!.source).toEqual({ kind: 'layerState', layer: 'Body', state: 'Hurt' })
    const gone = parseBehaviorMachine(removeBehaviorLayer(BRAIN, 'Health'))
    expect(gone.layers!.map(l => l.name)).toEqual(['Weapon'])
    expect(gone.parameters.find(p => p.name === 'Hurt For')!.source).toEqual({ kind: 'const', value: 0 })
    expect(gone.parameters.find(p => p.name === 'Is Hurt')!.source).toEqual({ kind: 'const', value: false })
    const noState = parseBehaviorMachine(removeBehaviorState(BRAIN, 'Health', 'Hurt'))
    expect(noState.layers![0].states.map(s => s.name)).toEqual(['Fine'])
    expect(noState.layers![0].transitions).toEqual([])
    expect(noState.parameters.find(p => p.name === 'Is Hurt')!.source).toEqual({ kind: 'const', value: false })
  })

  it('says what is wrong with a name: empty, the wildcard, taken', () => {
    expect(behaviorNameProblem('  ', [], 'state')).toMatch(/needs a name/)
    expect(behaviorNameProblem('*', [], 'state')).toMatch(/any state/)
    expect(behaviorNameProblem(' Fine ', ['Fine'], 'state')).toMatch(/Another state/)
    expect(behaviorNameProblem('Hurting', ['Fine'], 'state')).toBeNull()
  })
})
