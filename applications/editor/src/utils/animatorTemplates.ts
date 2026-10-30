// Ready-made Animators for the "Animate this character" wizard.
//
// A template is DATA: the clip slots it needs (each recognised by name), and a builder that turns the
// clips the user confirmed into a state machine — plus, for locomotion, the blend space that mixes walk,
// run and sprint by speed. Every parameter is LINKED to a measured built-in (planarSpeed, airTime, …), so
// the generated character animates with no script at all; only one-shot actions (attacks, rolls, hits)
// need a script to call `playAction`.
//
// Engine-free apart from types, so it is unit-testable.

import type {
  AnimationStateMachine, AnimationParameter, AnimationState, AnimationTransition, AnimationConditionGroup,
} from 'cleo'
import { buildAnimationFieldAsset, type AnimationFieldAsset } from './animationFields'

export type TemplateId = 'locomotion' | 'souls' | 'npc'

export type TemplateSlot = {
  key: string
  label: string
  required?: boolean
  /** What the slot is for, shown beside its picker. */
  hint: string
  /** Name patterns, best first. A clip matching an earlier pattern wins over a later one. */
  match: RegExp[]
  /** A clip whose name matches any of these is never guessed for this slot. */
  avoid?: RegExp[]
}

export type AnimatorTemplate = {
  id: TemplateId
  name: string
  description: string
  slots: TemplateSlot[]
  /** Turn foot placement on for the skeleton when it has none. */
  footPlacement: boolean
}

const S = {
  idle: { key: 'idle', label: 'Idle', required: true, hint: 'Standing still', match: [/^idle$/i, /idle/i, /stand/i, /breath/i], avoid: [/turn|crouch|aim/i] },
  walk: { key: 'walk', label: 'Walk', hint: 'Slow forward movement', match: [/^walk$/i, /walk/i], avoid: [/back|left|right|strafe|crouch|stop|start/i] },
  run: { key: 'run', label: 'Run', hint: 'Fast forward movement', match: [/^run$/i, /jog/i, /run/i], avoid: [/back|left|right|strafe|stop|start|sword|jump/i] },
  sprint: { key: 'sprint', label: 'Sprint', hint: 'Optional: the fastest gait (run is sped up when missing)', match: [/sprint/i], avoid: [/stop|start/i] },
  jump: { key: 'jump', label: 'Jump', hint: 'Taking off — plays while rising', match: [/jump.*(start|up|begin)/i, /^jump$/i, /jump/i], avoid: [/land|fall|loop|down/i] },
  fall: { key: 'fall', label: 'Fall', hint: 'In the air', match: [/fall/i, /jump.*loop/i, /air/i, /in.?air/i], avoid: [/land|death|dying|down/i] },
  land: { key: 'land', label: 'Land', hint: 'Touching down', match: [/land/i, /jump.*(end|down)/i] },
  death: { key: 'death', label: 'Death', hint: 'Played once on the "Died" trigger', match: [/death/i, /dying/i, /die\b/i, /dead/i] },
  attack: { key: 'attack', label: 'Attack', hint: 'A one-shot action — a script plays it with playAction', match: [/attack/i, /slash/i, /swing/i, /punch/i, /strike/i] },
  roll: { key: 'roll', label: 'Roll / Dodge', hint: 'A one-shot action — a script plays it with playAction', match: [/roll/i, /dodge/i, /evade/i] },
  hit: { key: 'hit', label: 'Hit reaction', hint: 'A one-shot action — a script plays it with playAction', match: [/hit/i, /impact/i, /react/i, /stagger/i] },
} satisfies Record<string, TemplateSlot>

export const ANIMATOR_TEMPLATES: AnimatorTemplate[] = [
  {
    id: 'locomotion', name: 'Third-person locomotion',
    description: 'Idle, walk/run/sprint blended by speed, jump, fall and land. Driven by how the character actually moves.',
    slots: [S.idle, S.walk, S.run, S.sprint, S.jump, S.fall, S.land],
    footPlacement: true,
  },
  {
    id: 'souls', name: 'Melee fighter',
    description: 'Locomotion plus a death state and an action slot for attacks, rolls and hit reactions played from a script.',
    slots: [S.idle, S.walk, S.run, S.sprint, S.fall, S.death, S.attack, S.roll, S.hit],
    footPlacement: true,
  },
  {
    id: 'npc', name: 'Simple NPC',
    description: 'Idle and walk, blended by speed. Enough for a wandering villager or a patrolling guard.',
    slots: [S.idle, S.walk, S.death],
    footPlacement: true,
  },
]

export function templateById(id: TemplateId): AnimatorTemplate {
  return ANIMATOR_TEMPLATES.find(t => t.id === id)!
}

/** A clip assigned to each slot, guessed from the clip names. Each clip is used at most once. */
export function guessClipSlots(template: AnimatorTemplate, clipNames: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  const used = new Set<string>()
  for (const slot of template.slots) {
    const candidates = clipNames.filter(c => !used.has(c) && !slot.avoid?.some(r => r.test(c)))
    let pick: string | undefined
    for (const re of slot.match) {
      // Shortest first among equal matches: "Run" over "Run Forward Loop" is the plainer clip.
      pick = candidates.filter(c => re.test(c)).sort((a, b) => a.length - b.length)[0]
      if (pick) break
    }
    out[slot.key] = pick
    if (pick) used.add(pick)
  }
  return out
}

/** The required slots still empty — the wizard cannot finish while any remain. */
export function missingRequired(template: AnimatorTemplate, assigned: Record<string, string | undefined>): TemplateSlot[] {
  return template.slots.filter(s => s.required && !assigned[s.key])
}

// ---- Building ---------------------------------------------------------------------------------------

/** Ground speeds (m/s) the generated blend space places its gaits at. Tunable afterwards in the editor. */
export const GAIT_SPEEDS = { walk: 1.5, run: 4, sprint: 6 }

const builtin = (name: string, varName: string, varType: 'number' | 'boolean' = 'number'): AnimationParameter => ({
  name, type: 'variable', default: varType === 'boolean' ? false : 0,
  variable: { nodeRef: 'parent', varName, varType, source: 'builtin' },
})

const all = (...children: AnimationConditionGroup['children']): AnimationConditionGroup => ({ op: 'and', children })
const edge = (from: string, to: string, condition?: AnimationConditionGroup, extra: Partial<AnimationTransition> = {}): AnimationTransition =>
  ({ from, to, conditions: [], ...(condition ? { condition } : {}), ...extra })

export type TemplateResult = {
  machine: AnimationStateMachine
  /** The locomotion blend space, when two or more gaits were assigned. Add it to the library. */
  field: AnimationFieldAsset | null
  /** Clips assigned to one-shot ACTIONS, for the summary ("play these from a script"). */
  actions: { slot: string; clip: string }[]
}

/**
 * The Animator for `template` with `assigned` clips, on skeleton `rigId`. `fieldId` fixes the blend space's
 * id (tests); otherwise one is minted.
 */
export function buildFromTemplate(
  template: AnimatorTemplate,
  assigned: Record<string, string | undefined>,
  rigId: string,
  opts: { name?: string; fieldId?: string } = {},
): TemplateResult {
  const has = (k: string) => template.slots.some(s => s.key === k) && !!assigned[k]
  const clip = (k: string) => assigned[k] ?? ''

  const parameters: AnimationParameter[] = [builtin('Speed', 'planarSpeed')]
  const states: AnimationState[] = []
  const transitions: AnimationTransition[] = []
  const at = (x: number, y: number) => ({ x, y })

  states.push({ name: 'Idle', clipName: clip('idle'), loop: true, speed: 1, isEntry: true, ...at(40, 40) })

  // ---- Locomotion: a blend space over the gaits present, or the single gait as a plain clip.
  const gaits = (['walk', 'run', 'sprint'] as const).filter(has)
  let field: AnimationFieldAsset | null = null
  const moving = gaits.length > 0
  if (gaits.length >= 2 || (gaits.length === 1 && gaits[0] !== 'walk')) {
    field = buildAnimationFieldAsset(`${opts.name ?? template.name} Locomotion`, rigId, opts.fieldId)
    field.mode = '1d'
    // The run (sped up) or the sprint covers the top of the range; a walk-only field never gets here.
    field.xAxis = { name: 'Speed', min: 0, max: has('run') || has('sprint') ? GAIT_SPEEDS.sprint : GAIT_SPEEDS.walk }
    field.samples = gaits.map(g => ({ clipName: clip(g), x: GAIT_SPEEDS[g] }))
    // No sprint clip: the run, played faster, covers the sprint speed so the feet do not slide past the edge.
    if (!has('sprint') && has('run')) field.samples.push({ clipName: clip('run'), x: GAIT_SPEEDS.sprint, rateScale: GAIT_SPEEDS.sprint / GAIT_SPEEDS.run })
    states.push({
      name: 'Locomotion', clipName: '', fieldId: field.id, fieldInputs: { x: 'Speed' },
      loop: true, speed: 1, ...at(300, 40),
    })
  } else if (moving) {
    states.push({ name: 'Locomotion', clipName: clip(gaits[0]), loop: true, speed: 1, ...at(300, 40) })
  }

  if (moving) {
    const speed = (op: 'gt' | 'lt', value: number) => all({ param: 'Speed', op, value, hysteresis: 0.15 })
    transitions.push(edge('Idle', 'Locomotion', speed('gt', 0.5), { minDwell: 0.05 }))
    transitions.push(edge('Locomotion', 'Idle', speed('lt', 0.5), { minDwell: 0.1 }))
  }
  const grounded = ['Idle', ...(moving ? ['Locomotion'] : [])]

  // ---- Air: jump on take-off, fall once airborne a moment, land on touch-down.
  const air = has('jump') || has('fall')
  if (air) {
    parameters.push(builtin('AirTime', 'airTime'), builtin('Grounded', 'isGrounded', 'boolean'))
    if (has('jump')) {
      parameters.push(builtin('RiseSpeed', 'verticalSpeed'))
      states.push({ name: 'Jump', clipName: clip('jump'), loop: false, speed: 1, ...at(170, 200) })
      for (const g of grounded) transitions.push(edge(g, 'Jump', all({ param: 'RiseSpeed', op: 'gt', value: 1.5 }, { param: 'Grounded', op: 'false' }), { blendTime: 0.1 }))
    }
    if (has('fall')) {
      states.push({ name: 'Fall', clipName: clip('fall'), loop: true, speed: 1, ...at(430, 200) })
      // A short grace: a step down a stair must not read as falling.
      for (const g of grounded) transitions.push(edge(g, 'Fall', all({ param: 'AirTime', op: 'gt', value: 0.25 })))
      if (has('jump')) transitions.push(edge('Jump', 'Fall', undefined, { hasExitTime: true, exitTime: 0.9 }))
    }
    const airborne = [...(has('jump') ? ['Jump'] : []), ...(has('fall') ? ['Fall'] : [])]
    if (has('land')) {
      states.push({ name: 'Land', clipName: clip('land'), loop: false, speed: 1, ...at(300, 330) })
      for (const a of airborne) transitions.push(edge(a, 'Land', all({ param: 'Grounded', op: 'true' }), { blendTime: 0.08 }))
      transitions.push(edge('Land', 'Idle', undefined, { hasExitTime: true, exitTime: 0.8 }))
      if (moving) transitions.push(edge('Land', 'Locomotion', all({ param: 'Speed', op: 'gt', value: 1 })))
    } else {
      for (const a of airborne) transitions.push(edge(a, 'Idle', all({ param: 'Grounded', op: 'true' }), { blendTime: 0.15 }))
    }
  }

  // ---- Death: a trigger a script (or the health system) fires, and one to bring the character back.
  if (has('death')) {
    parameters.push({ name: 'Died', type: 'trigger', default: false }, { name: 'Revive', type: 'trigger', default: false })
    states.push({ name: 'Dead', clipName: clip('death'), loop: false, speed: 1, ...at(170, 330) })
    for (const s of states) if (s.name !== 'Dead') transitions.push(edge(s.name, 'Dead', all({ param: 'Died', op: 'trigger' }), { blendTime: 0.15 }))
    transitions.push(edge('Dead', 'Idle', all({ param: 'Revive', op: 'trigger' })))
  }

  // ---- One-shot actions: a full-body slot the script plays attacks, rolls and hits into.
  const actions = (['attack', 'roll', 'hit'] as const).filter(has).map(k => ({ slot: k, clip: clip(k) }))
  const machine: AnimationStateMachine = { parameters, states, transitions, events: [] }
  if (template.id === 'souls' || actions.length) machine.slots = [{ name: 'Actions', blend: 'override' }]

  return { machine, field, actions }
}
