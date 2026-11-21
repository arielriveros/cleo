import { describe, it, expect } from 'vitest'
import { mat4 } from 'gl-matrix'
import { Animator } from 'cleo'
import type { AnimationState, AnimationStateMachine, AnimationTransition } from 'cleo'
import {
  addFork, setForkFields, removeFork, dissolveFork, moveTransition, waysIn, waysOut, rankOf, freshForkName, compose,
} from '../src/features/animation/forks'
import {
  createGroup, moveToGroup, nameTaken, removeGroup, layerView, writeLayer, graphPlan, transitionsBetween, PROXY_PREFIX,
} from '../src/features/animation/stateGroups'

// Forks in the animator editor: the pure half under the graph and the inspector. A fork is a junction: a transition
// into it goes on, in the same frame, through the first of its ways out that holds. What can go wrong here is
// silent: a rename that leaves a transition naming a fork that is gone, a dissolve that changes what the machine
// does, a layer view that shows the base's forks, an ungroup that hands a fork its group's ways out.

const when = (...params: string[]) => ({ op: 'and' as const, children: params.map(param => ({ param, op: 'true' as const })) })
const edge = (from: string, to: string, params: string[] = [], extra: Partial<AnimationTransition> = {}): AnimationTransition =>
  ({ from, to, conditions: [], condition: when(...params), hasExitTime: false, exitTime: 1, ...extra })
const state = (name: string): AnimationState => ({ name, clipName: name, loop: true, speed: 1, isEntry: name === 'Idle' } as AnimationState)

/** Idle and Run both take off through a fork: a running jump, a standing jump or a fall. */
function machine(): AnimationStateMachine {
  return {
    parameters: ['jump', 'fast', 'air', 'move', 'land'].map(name => ({ name, type: 'bool', default: false })) as any,
    states: ['Idle', 'Run', 'JumpRun', 'JumpStand', 'Fall'].map(state),
    transitions: [
      edge('Idle', 'Run', ['move']),
      edge('Idle', 'Take Off', [], { minDwell: 0.1 }),
      edge('Run', 'Take Off', [], { blendTime: 0.2 }),
      edge('Take Off', 'JumpRun', ['jump', 'fast'], { blendTime: 0.05 }),
      edge('Take Off', 'JumpStand', ['jump']),
      edge('Take Off', 'Fall', ['air'], { blendTime: 0.4 }),
      edge('Air', 'Idle', ['land']),
    ],
    groups: [{ name: 'Air', states: ['JumpRun', 'JumpStand', 'Fall'] }],
    forks: [{ name: 'Take Off', x: 10, y: 20 }],
    events: [],
  }
}

describe('forks: editing', () => {
  it('adds a fork under a name nothing has, into the open group when there is one', () => {
    const sm = machine()
    expect(freshForkName(sm)).toBe('Fork')
    const { view, name } = addFork(sm, { x: 1, y: 2 }, 'Air')
    expect(name).toBe('Fork')
    expect(view.forks).toContainEqual({ name: 'Fork', x: 1, y: 2 })
    expect(view.groups![0].states).toContain('Fork')
    expect(freshForkName(view)).toBe('Fork 2')
    expect(nameTaken(view, 'Take Off')).toBe(true)
    expect(nameTaken(view, '*')).toBe(true)
  })

  it('renames a fork into every transition and its group, and refuses a taken name', () => {
    let sm = moveToGroup(machine(), 'Take Off', 'Air')
    sm = { ...sm, groups: [{ ...sm.groups![0], entry: 'Take Off' }] }
    const next = setForkFields(sm, 'Take Off', { name: 'Leave Ground' })
    expect(next.forks!.map(f => f.name)).toEqual(['Leave Ground'])
    expect(next.transitions.filter(t => t.from === 'Leave Ground' || t.to === 'Leave Ground')).toHaveLength(5)
    expect(next.groups![0].states).toContain('Leave Ground')
    expect(next.groups![0].entry).toBe('Leave Ground')
    expect(setForkFields(sm, 'Take Off', { name: 'Idle' })).toBe(sm)
    expect(setForkFields(sm, 'Take Off', { name: 'Air' })).toBe(sm)
  })

  it('removes a fork with its transitions, and takes it out of its group', () => {
    const sm = moveToGroup(machine(), 'Take Off', 'Air')
    const next = removeFork(sm, 'Take Off')
    expect(next.forks).toBeUndefined()
    expect(next.transitions.map(t => `${t.from}>${t.to}`)).toEqual(['Idle>Run', 'Air>Idle'])
    expect(next.groups![0].states).not.toContain('Take Off')
  })

  it('knows its ways in (also through a group it is the entry of) and its ways out, ranked', () => {
    let sm = moveToGroup(machine(), 'Take Off', 'Air')
    sm = { ...sm, groups: [{ ...sm.groups![0], entry: 'Take Off' }], transitions: [...sm.transitions, edge('Run', 'Air', ['x'])] }
    expect(waysIn(sm, 'Take Off').map(t => `${t.from}>${t.to}`)).toEqual(['Idle>Take Off', 'Run>Take Off', 'Run>Air'])
    expect(waysOut(sm, 'Take Off').map(t => t.to)).toEqual(['JumpRun', 'JumpStand', 'Fall'])
    expect(waysOut(sm, 'Take Off').map(t => rankOf(sm, t))).toEqual([1, 2, 3])
    expect(rankOf(sm, sm.transitions[0])).toBe(0)
  })

  it('reorders a fork\'s ways out among themselves, leaving the rest where it was', () => {
    const sm = machine()
    const next = moveTransition(sm, 'Take Off', 'Fall', -1)
    expect(waysOut(next, 'Take Off').map(t => t.to)).toEqual(['JumpRun', 'Fall', 'JumpStand'])
    expect(next.transitions.filter(t => t.from !== 'Take Off')).toEqual(sm.transitions.filter(t => t.from !== 'Take Off'))
    expect(moveTransition(sm, 'Take Off', 'JumpRun', -1)).toBe(sm)
    expect(moveTransition(sm, 'Take Off', 'Fall', 1)).toBe(sm)
  })

  it('composes a way in and a way out: both gates, the later exit, the longer dwell, the way out\'s blend', () => {
    const t = compose(
      edge('A', 'F', ['a'], { minDwell: 0.3, hasExitTime: true, exitTime: 0.2, blendTime: 0.5 }),
      edge('F', 'B', ['b'], { minDwell: 0.1, hasExitTime: true, exitTime: 0.6 }))
    expect(t).toMatchObject({ from: 'A', to: 'B', minDwell: 0.3, hasExitTime: true, exitTime: 0.6, blendTime: 0.5 })
    expect(t.condition).toEqual({ op: 'and', children: [when('a'), when('b')] })
    expect(compose(edge('A', 'F'), edge('F', 'B', [], { blendTime: 0.1 }))).toMatchObject({ blendTime: 0.1, hasExitTime: false })
  })

  it('dissolves a fork and keeps what the machine does', () => {
    const forked = machine()
    const flat = dissolveFork(forked, 'Take Off')
    expect(flat.forks).toBeUndefined()
    expect(flat.transitions.map(t => `${t.from}>${t.to}`)).toEqual([
      'Idle>Run', 'Idle>JumpRun', 'Idle>JumpStand', 'Idle>Fall', 'Run>JumpRun', 'Run>JumpStand', 'Run>Fall', 'Air>Idle',
    ])
    expect(flat.transitions.find(t => t.from === 'Run' && t.to === 'JumpStand')!.blendTime).toBe(0.2)
    expect(flat.transitions.find(t => t.from === 'Run' && t.to === 'Fall')!.blendTime).toBe(0.4)
    expect(flat.transitions.find(t => t.from === 'Idle' && t.to === 'Fall')!.minDwell).toBe(0.1)

    // The same parameter run through both: the same states, frame by frame.
    const SKIN = { joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }], nodeTransforms: new Map([[0, mat4.create()]]) }
    const clip = (name: string) => ({
      name, samplers: [{ input: [0, 1], output: [0, 0, 0, 0, 0, 0], interpolation: 'LINEAR' }],
      channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
    })
    const run = (sm: AnimationStateMachine) => {
      const a = new Animator({ skin: SKIN, animations: sm.states.map(s => clip(s.name)) } as any)
      a.setStateMachine(sm)
      a.play()
      const trace: string[] = []
      const script: [string, boolean][][] = [
        [], [['jump', true]], [['jump', false], ['land', true]], [['land', false], ['move', true]], [],
        [['fast', true], ['jump', true]], [['jump', false], ['land', true]], [['land', false], ['air', true]], [],
        [['air', false], ['land', true]], [['land', false]],
      ]
      for (const sets of script) {
        for (const [k, v] of sets) a.setBool(k, v)
        for (let i = 0; i < 10; i++) { a.checkTriggers(); a.update(1 / 60) }
        trace.push(a.currentStateName ?? '')
      }
      return trace
    }
    const traced = run(forked)
    expect(traced).toEqual(run(flat))
    expect(new Set(traced)).toEqual(new Set(['Idle', 'JumpStand', 'Run', 'JumpRun', 'Fall']))
  })

  it('dissolves without a second transition for a pair that has one, or one back into the state it leaves', () => {
    const sm: AnimationStateMachine = {
      ...machine(),
      transitions: [edge('Idle', 'JumpStand', ['x']), edge('Idle', 'F'), edge('F', 'JumpStand'), edge('F', 'Idle'), edge('F', 'Fall')],
      forks: [{ name: 'F' }],
    }
    expect(dissolveFork(sm, 'F').transitions.map(t => `${t.from}>${t.to}`)).toEqual(['Idle>JumpStand', 'Idle>Fall'])
  })

  it('ungroups without handing a fork its group\'s ways out, and deletes a group with its forks', () => {
    let sm = moveToGroup(machine(), 'Take Off', 'Air')
    expect(sm.groups![0].states).toContain('Take Off')
    const ungrouped = removeGroup(sm, 'Air', 'ungroup')
    expect(ungrouped.transitions.filter(t => t.from === 'Take Off').map(t => t.to)).toEqual(['JumpRun', 'JumpStand', 'Fall'])
    expect(ungrouped.forks).toEqual(sm.forks)
    sm = machine()
    const made = createGroup(sm, ['Take Off', 'Idle'])!
    expect(made.view.groups!.find(g => g.name === made.name)!.states).toEqual(['Take Off', 'Idle'])
    const deleted = removeGroup(moveToGroup(machine(), 'Take Off', 'Air'), 'Air', 'delete')
    expect(deleted.forks).toBeUndefined()
  })

  it('keeps each layer\'s forks its own', () => {
    const sm: AnimationStateMachine = { ...machine(), layers: [{ name: 'Upper', states: [state('Aim')], transitions: [] }] }
    const view = layerView(sm, 1)
    expect(view.forks, 'the base\'s forks are not the layer\'s').toBeUndefined()
    const written = writeLayer(sm, 1, { ...view, forks: [{ name: 'Pick' }] })
    expect(written.layers![0].forks).toEqual([{ name: 'Pick' }])
    expect(written.forks).toEqual(sm.forks)
    expect(layerView(written, 1).forks).toEqual([{ name: 'Pick' }])
  })
})

describe('forks: the graph', () => {
  it('draws a fork outside every group as a node of its own, its lines plain', () => {
    const plan = graphPlan(machine(), null)
    expect(plan.forks).toEqual(['Take Off'])
    const idle = plan.links.find(l => l.a === 'Idle' && l.b === 'Take Off')!
    expect(idle.summary).toBe(false)
    expect(plan.links.find(l => l.nodeA === 'Take Off' && l.nodeB === 'Air')!.forward.map(t => t.to)).toEqual(['JumpRun', 'JumpStand', 'Fall'])
  })

  it('draws a group\'s entry fork inside it, and the group as one line from each source outside', () => {
    let sm = moveToGroup(machine(), 'Take Off', 'Air')
    sm = {
      ...sm,
      groups: [{ ...sm.groups![0], entry: 'Take Off' }],
      transitions: sm.transitions.map(t => (t.to === 'Take Off' ? { ...t, to: 'Air' } : t)),
    }
    const top = graphPlan(sm, null)
    expect(top.forks).toEqual([])
    expect(top.groups[0].forks).toEqual(['Take Off'])
    expect(top.links.filter(l => l.nodeB === 'Air').map(l => [l.nodeA, l.forward.length])).toEqual([['Idle', 1], ['Run', 1]])
    const inside = graphPlan(sm, 'Air')
    expect(inside.forks).toEqual(['Take Off'])
    expect(inside.states).toEqual(['JumpRun', 'JumpStand', 'Fall'])
    // Into the group is into its entry fork; the fork's ways out are plain lines to the states.
    const fork = inside.links.filter(l => l.nodeA === 'Take Off' || l.nodeB === 'Take Off').map(l => (l.nodeA === 'Take Off' ? l.nodeB : l.nodeA))
    expect(fork.sort()).toEqual([PROXY_PREFIX + 'Idle', PROXY_PREFIX + 'Run', 'Fall', 'JumpRun', 'JumpStand'])
    expect(transitionsBetween(sm, 'Air', 'Idle').map(t => t.from)).toEqual(['Air'])
  })
})
