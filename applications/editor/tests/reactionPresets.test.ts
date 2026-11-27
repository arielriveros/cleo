import { describe, it, expect } from 'vitest'
import type { AnimationStateMachine } from 'cleo'
import { NODE_BUILTINS } from 'cleo'
import { addHitLayer, addKnockDown, freeName } from '../src/features/animation/reactionPresets'
import { applyClipOverrides, machineClipNames } from '../src/utils/animationControllers'
import { normalizeParam } from '../src/features/animation/StateMachineContext'

// The animator's reaction presets (features/animation/reactionPresets.ts, the graph toolbar's Presets menu) and the
// Get Up state's clips in the controller helpers.

const machine = (): AnimationStateMachine => ({
  parameters: [{ name: 'Speed', type: 'float', default: 0 }],
  states: [{ name: 'Idle', clipName: 'Idle', loop: true, speed: 1, isEntry: true }, { name: 'Ragdoll', clipName: 'Fall', loop: true, speed: 1 }],
  transitions: [{ from: '*', to: 'Idle', conditions: [{ param: 'Speed', op: 'lt', value: 0.1 }] }],
  events: [],
})

describe('reaction presets', () => {
  it('knock-down states: a Ragdoll and a Get Up state wired to follow the body down and up, first among Any State', () => {
    const { machine: m, ragdoll, getUp } = addKnockDown(machine(), { x: 100, y: 200 })
    // Its names do not take the machine's own.
    expect([ragdoll, getUp]).toEqual(['Ragdoll 2', 'Get Up'])
    const r = m.states.find(s => s.name === ragdoll)!, g = m.states.find(s => s.name === getUp)!
    expect(r.ragdoll).toEqual({ start: 'fall' })
    expect(g.getUp).toEqual({})
    expect([r.x, r.y, g.x, g.y]).toEqual([100, 200, 320, 200])
    // The reaction built-ins it reads, Linked on the character.
    const param = (name: string) => m.parameters.find(p => p.name === name)!
    expect(param('Ragdolled').variable).toEqual({ nodeRef: 'parent', varName: 'ragdolled', varType: 'boolean', source: 'builtin' })
    expect(param('CanGetUp').variable?.varName).toBe('canGetUp')
    for (const p of m.parameters) if (p.variable) expect(NODE_BUILTINS[p.variable.varName]).toBeDefined()
    expect(m.transitions[0]).toMatchObject({ from: '*', to: ragdoll, conditions: [{ param: 'Ragdolled', op: 'true' }] })
    expect(m.transitions.slice(2).map(t => `${t.from}>${t.to}`)).toEqual([`${ragdoll}>${getUp}`, `${ragdoll}>Idle`, `${getUp}>Idle`])
    expect(m.transitions.find(t => t.from === getUp)).toMatchObject({ hasExitTime: true, exitTime: 0.95 })
    // Again: the parameters it has already are reused.
    const twice = addKnockDown(m).machine
    expect(twice.parameters.filter(p => p.variable?.varName === 'ragdolled').length).toBe(1)
  })

  it('a hit-reaction layer: additive, weighted by HasControl, a Hit state entered on every hit playing the blend space by angle and height', () => {
    const { machine: m, layer } = addHitLayer(machine(), { fieldId: 'hits' })
    const l = m.layers!.find(x => x.name === layer)!
    expect([l.name, l.blend, l.weightParam]).toEqual(['Hit Reaction', 'additive', 'HasControl'])
    const hit = m.parameters.find(p => p.name === 'Hit')!
    expect([hit.type, hit.variable?.varName]).toEqual(['trigger', 'hitCount'])
    expect(NODE_BUILTINS.hitCount.counter).toBe(true)
    const [off, state] = l.states
    expect([off.name, off.isEntry, off.clipName]).toEqual(['Off', true, ''])
    expect(state).toMatchObject({ name: 'Hit', loop: false, fieldId: 'hits', fieldInputs: { x: 'HitAngle', y: 'HitHeight' }, triggers: [{ trigger: 'Hit' }] })
    expect(l.transitions).toEqual([{ from: 'Hit', to: 'Off', conditions: [], hasExitTime: true, exitTime: 0.9, blendTime: 0.15 }])
    // A trigger keeps the counter it fires on through the parameter panel's normalising.
    expect(normalizeParam(hit).variable?.varName).toBe('hitCount')
    expect(normalizeParam({ name: 'X', type: 'float', default: 0, variable: hit.variable }).variable).toBeUndefined()
  })

  it('names like the base, numbered from 2', () => {
    expect(freeName('Get Up', [])).toBe('Get Up')
    expect(freeName('Get Up', ['Get Up', 'Get Up 2'])).toBe('Get Up 3')
  })
})

describe('a Get Up state in the controller helpers', () => {
  it('names its clips among those the machine plays, and takes clip overrides', () => {
    const m: AnimationStateMachine = { ...machine(), states: [...machine().states, { name: 'Get Up', clipName: '', loop: false, speed: 1, getUp: { faceUp: 'Stand Up', faceDown: 'Getting Up' } }] }
    expect(machineClipNames(m)).toEqual(expect.arrayContaining(['Stand Up', 'Getting Up']))
    const swapped = applyClipOverrides(m, { 'Stand Up': 'Rise Back' })
    expect(swapped.states.find(s => s.name === 'Get Up')!.getUp).toEqual({ faceUp: 'Rise Back', faceDown: 'Getting Up' })
  })
})
