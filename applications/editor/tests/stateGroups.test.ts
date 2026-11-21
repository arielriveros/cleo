import { describe, it, expect } from 'vitest'
import { mat4 } from 'gl-matrix'
import { Animator } from 'cleo'
import type { AnimationState, AnimationStateMachine, AnimationTransition } from 'cleo'
import {
  createGroup, setGroupFields, removeGroup, moveToGroup, renameStateInGroups, dropStatesFromGroups, freshGroupName,
  layerView, writeLayer, graphPlan, transitionsBetween, entryOf, PROXY_PREFIX, SELF_PREFIX, inPort, outPort,
} from '../src/features/animation/stateGroups'

// State groups in the animator editor: the pure half under the graph and the inspector. A group is drawn as one
// node with a port per outside end; its own transitions fire from any of its states. What can go wrong here is
// silent: a rename that leaves a transition naming a group that is gone, an ungroup that changes what the
// machine does, a layer view that shows the base's groups. (The Sandbox's own animator:
// examples/sandbox/tests/stateGroups.test.ts.)

const when = (param: string) => ({ op: 'and' as const, children: [{ param, op: 'true' as const }] })
const edge = (from: string, to: string, param = 'go'): AnimationTransition =>
  ({ from, to, conditions: [], condition: when(param), hasExitTime: false, exitTime: 1, blendTime: 0 })
const state = (name: string, x?: number, y?: number): AnimationState =>
  ({ name, clipName: name, loop: true, speed: 1, isEntry: name === 'Idle', ...(x !== undefined ? { x, y } : {}) } as AnimationState)

/** Idle, a run, and two stops in a group with a shared way into the air. */
function machine(): AnimationStateMachine {
  return {
    parameters: ['go', 'stop', 'air', 'move', 'done'].map(name => ({ name, type: 'bool', default: false })) as any,
    states: [state('Idle', 0, 0), state('Run', 200, 0), state('Stop', 0, 200), state('StopMirror', 200, 200), state('Fall', 400, 0)],
    transitions: [
      edge('Idle', 'Run', 'move'),
      edge('Run', 'Stop', 'stop'),
      edge('Run', 'StopMirror', 'stop'),
      edge('Stop', 'Idle', 'done'),
      edge('StopMirror', 'Idle', 'done'),
      edge('Stop', 'Run', 'move'),
      edge('Stopping', 'Fall', 'air'),
      edge('Fall', 'Stopping', 'done'),
    ],
    groups: [{ name: 'Stopping', states: ['Stop', 'StopMirror'], x: 100, y: 200 }],
    events: [],
  }
}

describe('state groups: editing', () => {
  it('groups states at their middle, each leaving the group it was in, under a name nothing has', () => {
    const made = createGroup(machine(), ['Idle', 'Stop', 'nope'])!
    expect(made.name).toBe('Group')
    const g = made.view.groups!.find(x => x.name === 'Group')!
    expect(g.states).toEqual(['Idle', 'Stop'])
    expect([g.x, g.y]).toEqual([0, 100])
    expect(made.view.groups!.find(x => x.name === 'Stopping')!.states).toEqual(['StopMirror'])
    expect(createGroup(machine(), ['nope'])).toBeNull()
    expect(freshGroupName({ ...machine(), groups: [{ name: 'Group', states: [] }] })).toBe('Group 2')
    // A name a state has is never a group's.
    expect(createGroup(machine(), ['Idle'], 'Run')!.name).toBe('Group')
  })

  it('renames a group into every transition from or to it, and refuses a name taken', () => {
    const view = setGroupFields(machine(), 'Stopping', { name: 'Stops' })
    expect(view.groups!.map(g => g.name)).toEqual(['Stops'])
    expect(view.transitions.filter(t => t.from === 'Stops' || t.to === 'Stops')).toHaveLength(2)
    expect(view.transitions.some(t => t.from === 'Stopping' || t.to === 'Stopping')).toBe(false)
    expect(setGroupFields(machine(), 'Stopping', { name: 'Idle' })).toEqual(machine())
    expect(setGroupFields(machine(), 'Stopping', { name: '' })).toEqual(machine())
    // An entry that is not a member is dropped.
    expect(setGroupFields(machine(), 'Stopping', { entry: 'Idle' }).groups![0].entry).toBeUndefined()
    expect(setGroupFields(machine(), 'Stopping', { entry: 'StopMirror' }).groups![0].entry).toBe('StopMirror')
  })

  it('ungroups without changing what the machine does: the group\'s ways out on each state, the way in to its entry', () => {
    const view = removeGroup(machine(), 'Stopping', 'ungroup')
    expect(view.groups).toBeUndefined()
    const pairs = view.transitions.map(t => `${t.from}>${t.to}`)
    expect(pairs).toEqual(expect.arrayContaining(['Stop>Fall', 'StopMirror>Fall', 'Fall>Stop']))
    expect(pairs.some(p => p.includes('Stopping'))).toBe(false)
    // After each state's own, as the group's were: appended.
    expect(pairs.slice(-2)).toEqual(['Stop>Fall', 'StopMirror>Fall'])
    // A state that already goes there keeps its own and gets no second one.
    const own = { ...machine(), transitions: [...machine().transitions, edge('Stop', 'Fall', 'move')] }
    expect(removeGroup(own, 'Stopping', 'ungroup').transitions.filter(t => t.from === 'Stop' && t.to === 'Fall')).toHaveLength(1)
  })

  it('ungrouping leaves the runtime machine taking the same states', () => {
    const SKIN = { joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }], nodeTransforms: new Map([[0, mat4.create()]]) }
    const clip = (name: string) => ({
      name, samplers: [{ input: [0, 1], output: [0, 0, 0, 0, 0, 0], interpolation: 'LINEAR' }],
      channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
    })
    const run = (sm: AnimationStateMachine) => {
      const a = new Animator({ skin: SKIN, animations: sm.states.map(s => clip(s.name)) } as any)
      a.setStateMachine(JSON.parse(JSON.stringify(sm)))
      a.play()
      const trace: string[] = []
      for (const param of ['move', 'stop', 'air', 'done', 'move', 'stop', 'done', 'air', 'done']) {
        a.setBool(param, true)
        for (let k = 0; k < 3; k++) { a.checkTriggers(); a.update(1 / 60) }
        a.setBool(param, false)
        trace.push(a.currentStateName ?? '')
      }
      return trace
    }
    const grouped = run(machine())
    expect(grouped).toContain('Fall')
    expect(run(removeGroup(machine(), 'Stopping', 'ungroup'))).toEqual(grouped)
  })

  it('deletes a group with its states and every transition touching them', () => {
    const view = removeGroup(machine(), 'Stopping', 'delete')
    expect(view.states.map(s => s.name)).toEqual(['Idle', 'Run', 'Fall'])
    expect(view.transitions.map(t => `${t.from}>${t.to}`)).toEqual(['Idle>Run'])
    expect(view.groups).toBeUndefined()
  })

  it('moves states between groups, and follows a state renamed or removed', () => {
    const into = moveToGroup(machine(), 'Idle', 'Stopping')
    expect(into.groups![0].states).toEqual(['Stop', 'StopMirror', 'Idle'])
    expect(moveToGroup(into, 'Idle', null).groups![0].states).toEqual(['Stop', 'StopMirror'])
    expect(moveToGroup(machine(), 'Idle', 'Nope')).toEqual(machine())
    const entry = [{ name: 'G', states: ['A', 'B'], entry: 'B' }]
    expect(renameStateInGroups(entry, 'B', 'C')).toEqual([{ name: 'G', states: ['A', 'C'], entry: 'C' }])
    expect(dropStatesFromGroups(entry, new Set(['B']))).toEqual([{ name: 'G', states: ['A'] }])
    expect(entryOf({ name: 'G', states: ['A', 'B'], entry: 'gone' })).toBe('A')
  })

  it('gives each layer its own groups, and the base keeps its own', () => {
    const sm: AnimationStateMachine = {
      ...machine(),
      layers: [{ name: 'Upper', states: [state('Wave'), state('Rest')], transitions: [], weight: 1 } as any],
    }
    const layer = layerView(sm, 1)
    expect(layer.groups).toBeUndefined()
    const grouped = createGroup(layer, ['Wave'])!.view
    const written = writeLayer(sm, 1, grouped)
    expect(written.layers![0].groups).toEqual([{ name: 'Group', states: ['Wave'] }])
    expect(written.groups).toEqual(machine().groups)
    expect(layerView(written, 1).groups).toEqual([{ name: 'Group', states: ['Wave'] }])
    // Ungrouping the layer's last group drops the key.
    expect('groups' in writeLayer(written, 1, removeGroup(layerView(written, 1), 'Group', 'ungroup')).layers![0]).toBe(false)
  })
})

describe('state groups: the graph', () => {
  it('draws a group as one node with a port per outside end, its own transitions dashed', () => {
    const plan = graphPlan(machine(), null)
    expect(plan.states).toEqual(['Idle', 'Run', 'Fall'])
    const [g] = plan.groups
    expect(g.name).toBe('Stopping')
    expect(g.inputs).toEqual(['Run', 'Fall'])
    expect(g.outputs).toEqual(['Idle', 'Run', 'Fall'])
    const link = (key: string) => plan.links.find(l => l.key === key)!
    // Run -> Stop and Run -> StopMirror: one line into the group's Run port, standing for both.
    expect(link('Run>Stopping').forward.map(t => t.to)).toEqual(['Stop', 'StopMirror'])
    expect(link('Run>Stopping').targetHandle).toBe(inPort('Run'))
    expect(link('Run>Stopping').summary).toBe(true)
    expect(link('Run>Stopping').dashed).toBe(false)
    // The group's own way into the air: a real pair, dashed, out of the Fall port.
    expect(link('Stopping>Fall').summary).toBe(false)
    expect(link('Stopping>Fall').dashed).toBe(true)
    expect(link('Stopping>Fall').sourceHandle).toBe(outPort('Fall'))
    // Plain pairs stay one line both ways.
    expect(link('Idle|Run').forward.map(t => `${t.from}>${t.to}`)).toEqual(['Idle>Run'])
    expect(transitionsBetween(machine(), 'Stopping', 'Idle').map(t => t.from)).toEqual(['Stop', 'StopMirror'])
  })

  it('opens a group: its states, a stand-in per outside end, and its own node where its transitions start', () => {
    const plan = graphPlan(machine(), 'Stopping')
    expect(plan.states).toEqual(['Stop', 'StopMirror'])
    expect(plan.self).toBe(SELF_PREFIX + 'Stopping')
    expect(plan.proxies.map(p => [p.name, p.side])).toEqual([['Run', 'out'], ['Idle', 'out'], ['Fall', 'out']])
    const fromSelf = plan.links.find(l => l.key === 'Stopping>Fall')!
    expect([fromSelf.nodeA, fromSelf.nodeB, fromSelf.dashed]).toEqual([SELF_PREFIX + 'Stopping', PROXY_PREFIX + 'Fall', true])
    // Into the group: drawn into its entry (the first state, as it has none set).
    const intoGroup = plan.links.find(l => l.key === 'Fall>Stopping')!
    expect([intoGroup.nodeA, intoGroup.nodeB]).toEqual([PROXY_PREFIX + 'Fall', 'Stop'])
    // A member and an outside state: one line both ways, between the member and the stand-in.
    const run = plan.links.find(l => l.key === 'Run|Stop')!
    expect([run.nodeA, run.nodeB, run.forward.length, run.backward.length]).toEqual([PROXY_PREFIX + 'Run', 'Stop', 1, 1])
  })

  it('draws an ungrouped machine exactly as it always did', () => {
    const sm = removeGroup(machine(), 'Stopping', 'ungroup')
    const plan = graphPlan(sm, null)
    expect(plan.groups).toEqual([])
    expect(plan.links.every(l => !l.summary && !l.dashed && !l.sourceHandle && !l.targetHandle)).toBe(true)
    expect(plan.links.map(l => l.key).sort()).toEqual(['Fall|Stop', 'Fall|StopMirror', 'Idle|Run', 'Idle|Stop', 'Idle|StopMirror', 'Run|Stop', 'Run|StopMirror'])
  })
})
