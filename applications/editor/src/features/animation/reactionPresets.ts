import type { AnimationLayer, AnimationParameter, AnimationStateMachine, AnimationTransition } from 'cleo'

// The animator's two reaction presets (the graph toolbar's Presets menu): the usual wiring for a character whose
// body the physics takes (Ragdoll and Get Up states), and a hit-reaction layer (an additive flinch picked by where a
// hit came from). Pure: machine in, machine out. Parameters the machine already has for the same reaction value are
// reused rather than duplicated.

/** `base`, or `base 2`, `base 3`… whichever no name in `taken` has. */
export function freeName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken)
  if (!set.has(base)) return base
  let n = 2
  while (set.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/** Every name a state of this view could clash with: its states, groups and forks. */
function takenNames(sm: { states: { name: string }[]; groups?: { name: string }[]; forks?: { name: string }[] }): string[] {
  return [...sm.states.map(s => s.name), ...(sm.groups ?? []).map(g => g.name), ...(sm.forks ?? []).map(f => f.name)]
}

/**
 * A Linked parameter reading the reaction built-in `varName` (on the character, 'parent'): the machine's own when
 * it has one, else a new one named `want` (or the first free name like it).
 */
function linkedBuiltin(params: AnimationParameter[], want: string, varName: string, varType: 'number' | 'boolean'): string {
  const have = params.find(p => p.type === 'variable' && p.variable?.source === 'builtin' && p.variable.varName === varName)
  if (have) return have.name
  const name = freeName(want, params.map(p => p.name))
  params.push({ name, type: 'variable', default: varType === 'boolean' ? false : 0, variable: { nodeRef: 'parent', varName, varType, source: 'builtin' } })
  return name
}

/** A trigger that fires on every rise of the counter built-in `varName`: the machine's own, else a new one. */
function linkedTrigger(params: AnimationParameter[], want: string, varName: string): string {
  const have = params.find(p => p.type === 'trigger' && p.variable?.source === 'builtin' && p.variable.varName === varName)
  if (have) return have.name
  const name = freeName(want, params.map(p => p.name))
  params.push({ name, type: 'trigger', default: false, variable: { nodeRef: 'parent', varName, varType: 'number', source: 'builtin' } })
  return name
}

/**
 * Knock-down states on the base layer: a Ragdoll state the graph enters from anywhere when the body leaves its feet
 * (Ragdolled), a Get Up state it rises on once it can (CanGetUp), and back to the entry state at its end. Its own
 * way back to the entry, for a body that is up again without rising (reset, no body made).
 */
export function addKnockDown(sm: AnimationStateMachine, at: { x: number; y: number } = { x: 0, y: 0 }): { machine: AnimationStateMachine; ragdoll: string; getUp: string } {
  const parameters = [...sm.parameters]
  const ragdolled = linkedBuiltin(parameters, 'Ragdolled', 'ragdolled', 'boolean')
  const canGetUp = linkedBuiltin(parameters, 'CanGetUp', 'canGetUp', 'boolean')
  const taken = takenNames(sm)
  const ragdoll = freeName('Ragdoll', taken)
  const getUp = freeName('Get Up', [...taken, ragdoll])
  const entry = sm.states.find(s => s.isEntry)?.name ?? sm.states[0]?.name
  const into: AnimationTransition = { from: '*', to: ragdoll, conditions: [{ param: ragdolled, op: 'true' }], blendTime: 0.1 }
  const out: AnimationTransition[] = [
    { from: ragdoll, to: getUp, conditions: [{ param: canGetUp, op: 'true' }], blendTime: 0 },
  ]
  if (entry) {
    out.push({ from: ragdoll, to: entry, conditions: [{ param: ragdolled, op: 'false' }], blendTime: 0.2 })
    out.push({ from: getUp, to: entry, conditions: [], hasExitTime: true, exitTime: 0.95, blendTime: 0.25 })
  }
  return {
    machine: {
      ...sm,
      parameters,
      states: [
        ...sm.states,
        { name: ragdoll, clipName: '', loop: true, speed: 1, ragdoll: { start: 'fall' }, isEntry: sm.states.length === 0, x: at.x, y: at.y },
        { name: getUp, clipName: '', loop: false, speed: 1, getUp: {}, x: at.x + 220, y: at.y },
      ],
      // First among the ways from anywhere: a fall interrupts whatever the graph is doing.
      transitions: [into, ...sm.transitions, ...out],
    },
    ragdoll, getUp,
  }
}

/**
 * A hit-reaction layer: additive, shown while the character keeps its control (HasControl), an empty Off state and a
 * Hit state entered on every hit (the Hit trigger, linked to the hit count) playing `fieldId` — a blend space over
 * where the hit came from (HitAngle) and how high it landed (HitHeight) — back to Off near its end. The shape of a
 * recoil layer.
 */
export function addHitLayer(sm: AnimationStateMachine, opts: { fieldId?: string; mask?: { maskId?: string; mask?: Record<string, number> } } = {}): { machine: AnimationStateMachine; layer: string } {
  const parameters = [...sm.parameters]
  const control = linkedBuiltin(parameters, 'HasControl', 'hasControl', 'boolean')
  const angle = linkedBuiltin(parameters, 'HitAngle', 'hitAngle', 'number')
  const height = linkedBuiltin(parameters, 'HitHeight', 'hitHeight', 'number')
  const hit = linkedTrigger(parameters, 'Hit', 'hitCount')
  const name = freeName('Hit Reaction', (sm.layers ?? []).map(l => l.name))
  const layer: AnimationLayer = {
    name, blend: 'additive', weightParam: control,
    ...(opts.mask?.maskId ? { maskId: opts.mask.maskId } : {}), ...(opts.mask?.mask ? { mask: opts.mask.mask } : {}),
    states: [
      { name: 'Off', clipName: '', loop: true, speed: 1, isEntry: true, x: 40, y: 40 },
      {
        name: 'Hit', clipName: '', loop: false, speed: 1, x: 280, y: 40,
        ...(opts.fieldId ? { fieldId: opts.fieldId, fieldInputs: { x: angle, y: height } } : {}),
        triggers: [{ trigger: hit, blendTime: 0.03 }],
      },
    ],
    transitions: [{ from: 'Hit', to: 'Off', conditions: [], hasExitTime: true, exitTime: 0.9, blendTime: 0.15 }],
  }
  return { machine: { ...sm, parameters, layers: [...(sm.layers ?? []), layer] }, layer: name }
}
