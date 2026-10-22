import { describe, it, expect } from 'vitest'
import {
  ANIMATOR_TEMPLATES, GAIT_SPEEDS, buildFromTemplate, guessClipSlots, missingRequired, templateById,
} from '../src/utils/animatorTemplates'

// The "Animate this character" wizard must turn a pile of Mixamo-named clips into a working Animator with
// no hand-wiring. These pin the name guessing and the structural soundness of every generated machine.

const MIXAMO = [
  'Idle', 'Breathing Idle', 'Walking', 'Running', 'Fast Run', 'Sprint', 'Jumping Up', 'Falling Idle',
  'Falling To Landing', 'Dying', 'Sword And Shield Slash', 'Stand To Roll', 'Hit Reaction', 'Left Strafe Walk',
]

const leafParams = (c: any): string[] => !c ? [] : c.children ? c.children.flatMap(leafParams) : [c.param]

function assertSound(machine: ReturnType<typeof buildFromTemplate>['machine']) {
  const names = new Set(machine.states.map(s => s.name))
  expect(names.size).toBe(machine.states.length)
  expect(machine.states.filter(s => s.isEntry)).toHaveLength(1)
  const params = new Set(machine.parameters.map(p => p.name))
  for (const t of machine.transitions) {
    expect(names.has(t.from)).toBe(true)
    expect(names.has(t.to)).toBe(true)
    for (const p of leafParams(t.condition)) expect(params.has(p)).toBe(true)
  }
  // Every parameter is either linked to a measured value or a trigger a script fires.
  for (const p of machine.parameters) expect(['variable', 'trigger']).toContain(p.type)
}

describe('guessClipSlots', () => {
  it('finds the plain clip for each slot and never reuses one', () => {
    const g = guessClipSlots(templateById('locomotion'), MIXAMO)
    expect(g).toMatchObject({
      idle: 'Idle', walk: 'Walking', run: 'Running', sprint: 'Sprint',
      jump: 'Jumping Up', fall: 'Falling Idle', land: 'Falling To Landing',
    })
    const used = Object.values(g).filter(Boolean)
    expect(new Set(used).size).toBe(used.length)
  })

  it('does not take a strafe for the walk', () => {
    expect(guessClipSlots(templateById('npc'), ['Left Strafe Walk', 'Idle']).walk).toBeUndefined()
  })

  it('reports a missing required slot', () => {
    const t = templateById('locomotion')
    expect(missingRequired(t, guessClipSlots(t, ['Walking'])).map(s => s.key)).toEqual(['idle'])
  })
})

describe('buildFromTemplate', () => {
  for (const template of ANIMATOR_TEMPLATES) {
    it(`builds a sound machine for "${template.name}" with every clip`, () => {
      const r = buildFromTemplate(template, guessClipSlots(template, MIXAMO), 'rig', { fieldId: 'f' })
      assertSound(r.machine)
    })
    it(`builds a sound machine for "${template.name}" with only an idle`, () => {
      const r = buildFromTemplate(template, { idle: 'Idle' }, 'rig')
      assertSound(r.machine)
      expect(r.machine.states.map(s => s.name)).toEqual(['Idle'])
      expect(r.field).toBeNull()
    })
  }

  it('blends the gaits by speed, with the run sped up to cover a missing sprint', () => {
    const r = buildFromTemplate(templateById('locomotion'), { idle: 'Idle', walk: 'Walking', run: 'Running' }, 'rig', { fieldId: 'f' })
    expect(r.field?.rigId).toBe('rig')
    expect(r.field?.samples).toEqual([
      { clipName: 'Walking', x: GAIT_SPEEDS.walk },
      { clipName: 'Running', x: GAIT_SPEEDS.run },
      { clipName: 'Running', x: GAIT_SPEEDS.sprint, rateScale: GAIT_SPEEDS.sprint / GAIT_SPEEDS.run },
    ])
    const loco = r.machine.states.find(s => s.name === 'Locomotion')!
    expect(loco.fieldId).toBe('f')
    expect(loco.fieldInputs).toEqual({ x: 'Speed' })
  })

  it('plays a lone walk as a plain clip', () => {
    const r = buildFromTemplate(templateById('npc'), { idle: 'Idle', walk: 'Walking' }, 'rig')
    expect(r.field).toBeNull()
    expect(r.machine.states.find(s => s.name === 'Locomotion')?.clipName).toBe('Walking')
  })

  it('gives the fighter an action slot and lists its actions', () => {
    const t = templateById('souls')
    const r = buildFromTemplate(t, guessClipSlots(t, MIXAMO), 'rig')
    expect(r.machine.slots?.map(s => s.name)).toEqual(['Actions'])
    expect(r.actions.map(a => a.slot)).toEqual(['attack', 'roll', 'hit'])
  })
})
