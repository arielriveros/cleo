import { describe, it, expect } from 'vitest'
import { HistoryManager } from 'cleo'
import type { AnimationStateMachine } from 'cleo'
import { machineRecorder, selectionHolds, viewIn, type MachineStep, type MachineView } from '../src/features/animation/machineHistory'

// Undo for the animator graph: its working copy is React state, so each mutator reports its edit and one tick's
// edits are one step that puts the whole machine back.

const machine = (states: string[], extra: Partial<AnimationStateMachine> = {}): AnimationStateMachine => ({
  states: states.map((name, i) => ({ name, clipName: '', loop: true, speed: 1, isEntry: i === 0 })),
  transitions: [], parameters: [], events: [], ...extra,
} as AnimationStateMachine)

/** A session: the machine, the view, a recorder over them and the steps it pushed. Ticks are closed by hand. */
function session(start: AnimationStateMachine) {
  let sm = start
  let view: MachineView = { layer: 0, group: null }
  const steps: MachineStep[] = []
  const queue: (() => void)[] = []
  const restored: { tabId: string; view: MachineView }[] = []
  const rec = machineRecorder({
    machine: () => sm,
    view: () => view,
    push: step => steps.push(step),
    restore: (tabId, m, v) => { sm = m; view = v; restored.push({ tabId, view: v }) },
    schedule: close => queue.push(close),
  })
  const edit = (fn: (m: AnimationStateMachine) => AnimationStateMachine, opts?: Parameters<typeof rec.edit>[2]) => {
    rec.edit('tab', sm, opts)
    sm = fn(sm)
  }
  const tick = () => { while (queue.length) queue.shift()!() }
  return {
    edit, tick, steps, restored,
    get sm() { return sm },
    setView: (v: MachineView) => { view = v },
  }
}

const rename = (from: string, to: string) => (m: AnimationStateMachine) =>
  ({ ...m, states: m.states.map(s => (s.name === from ? { ...s, name: to } : s)) })
const moveTo = (name: string, x: number, y: number) => (m: AnimationStateMachine) =>
  ({ ...m, states: m.states.map(s => (s.name === name ? { ...s, x, y } : s)) })

describe('animator undo steps', () => {
  it('makes one step of a tick, and its undo and redo put the whole machine back', () => {
    const s = session(machine(['Idle', 'Walk']))
    const before = s.sm
    // A multi-select drag: every node moved through its own setState in one handler.
    s.edit(moveTo('Idle', 10, 20), { label: 'Move', merge: 'state:0:0:x,y' })
    s.edit(moveTo('Walk', 30, 40), { label: 'Move', merge: 'state:0:1:x,y' })
    const after = s.sm
    s.tick()
    expect(s.steps).toHaveLength(1)
    expect(s.steps[0].label).toBe('Move')
    // Two different keys in one tick: nothing to merge the step with later.
    expect(s.steps[0].coalesceKey).toBeUndefined()
    s.steps[0].undo()
    expect(s.sm).toBe(before)
    s.steps[0].redo()
    expect(s.sm).toBe(after)
  })

  it('records no step for a silent change or one that changed nothing', () => {
    const s = session(machine(['Idle']))
    s.edit(moveTo('Idle', 5, 5), { silent: true })
    s.tick()
    s.edit(m => ({ ...m }), { label: 'Add transition' })
    s.tick()
    expect(s.steps).toHaveLength(0)
  })

  it('goes back to the layer and group the edit was made in, and forward to where it left the view', () => {
    const s = session(machine(['Idle'], { layers: [{ name: 'Upper', states: [], transitions: [], weight: 1, blend: 'override' }] }))
    s.setView({ layer: 1, group: null })
    s.edit(rename('Idle', 'Rest'), { label: 'Rename state' })
    s.setView({ layer: 0, group: null })
    s.tick()
    s.steps[0].undo()
    expect(s.restored.at(-1)).toEqual({ tabId: 'tab', view: { layer: 1, group: null } })
    s.steps[0].redo()
    expect(s.restored.at(-1)).toEqual({ tabId: 'tab', view: { layer: 0, group: null } })
  })

  it('puts back what the step changed outside the machine too', () => {
    const s = session(machine(['Idle']))
    const log: string[] = []
    // Tidy: the states' coordinates in the machine, Any State's session position beside it.
    s.edit(moveTo('Idle', 0, 0), { label: 'Tidy', also: { undo: () => log.push('undo any'), redo: () => log.push('redo any') } })
    s.tick()
    s.steps[0].undo()
    s.steps[0].redo()
    expect(log).toEqual(['undo any', 'redo any'])
    expect(s.sm.states[0].x).toBe(0)
  })

  it('merges a scrubbed field into one undo on the tab’s stack', () => {
    const s = session(machine(['Idle']))
    const history = new HistoryManager({ limit: 200, coalesceMs: 400 })
    const first = s.sm
    const speed = (v: number) => (m: AnimationStateMachine) => ({ ...m, states: m.states.map(x => ({ ...x, speed: v })) })
    for (const v of [1.1, 1.2, 1.3]) {
      s.edit(speed(v), { label: 'State settings', merge: 'state:0:0:speed' })
      s.tick()
      const step = s.steps.at(-1)!
      history.push({ ...step, time: Date.now() })
    }
    expect(s.steps[0].coalesceKey).toBe('tab:state:0:0:speed')
    expect(history.depth).toBe(1)
    history.undo()
    expect(s.sm).toBe(first)
    history.redo()
    expect(s.sm.states[0].speed).toBe(1.3)
  })
})

describe('the view an undo shows', () => {
  const layered = machine(['Idle'], {
    layers: [{ name: 'Upper', states: [{ name: 'Aim', clipName: '', loop: true, speed: 1, isEntry: true }], transitions: [], weight: 1, blend: 'override',
      groups: [{ name: 'Arms', states: ['Aim'] }] }],
  } as Partial<AnimationStateMachine>)

  it('keeps a layer and group that are there, and falls back when they are not', () => {
    expect(viewIn(layered, { layer: 1, group: 'Arms' })).toEqual({ layer: 1, group: 'Arms' })
    expect(viewIn(layered, { layer: 2, group: 'Arms' })).toEqual({ layer: 0, group: null })
    expect(viewIn(layered, { layer: 1, group: 'Legs' })).toEqual({ layer: 1, group: null })
  })

  it('keeps the selection only while what it names is still there', () => {
    const sm = machine(['Idle', 'Walk'], { transitions: [{ from: 'Walk', to: 'Idle', conditions: [], hasExitTime: false, exitTime: 1 }] } as Partial<AnimationStateMachine>)
    expect(selectionHolds(sm, { kind: 'state', name: 'Walk' })).toBe(true)
    expect(selectionHolds(sm, { kind: 'state', name: 'Run' })).toBe(false)
    expect(selectionHolds(sm, { kind: 'transition', a: 'Idle', b: 'Walk' })).toBe(true)
    expect(selectionHolds(sm, { kind: 'transition', a: 'Idle', b: 'Run' })).toBe(false)
    expect(selectionHolds(sm, { kind: 'summary', from: '*', to: 'Idle' })).toBe(true)
    expect(selectionHolds(sm, { kind: 'group', name: 'Arms' })).toBe(false)
    expect(selectionHolds(sm, null)).toBe(true)
  })
})
