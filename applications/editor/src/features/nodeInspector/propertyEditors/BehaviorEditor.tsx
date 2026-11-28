import { useMemo, useState } from 'react'
import { AI_GOALS, ControllerNode, parseBehaviorMachine } from 'cleo'
import type {
  AiGoal, BehaviorMachine, BehaviorOutput, BehaviorParameter, BehaviorParameterSource, BehaviorParameterType,
  BehaviorState, BehaviorTransition, StrafeSide,
} from 'cleo'
import { useAiEditor } from '../../ai/AiEditorContext'
import ConditionTreeView, { emptyConditionGroup } from '../../../components/ConditionTreeView'
import ParamSourcePicker from './ParamSourcePicker'
import type { ConditionParam } from '../../../components/ConditionTreeView'
import {
  Button, ButtonWithConfirm, DocScope, SectionTitle, Select, Slider, TextInput, Toggle, hintClass, labelClass,
} from '@cleo/app-kit/ui'

/**
 * The behaviour state machine: which goal this controller pursues, and what makes it change its mind.
 *
 * A LIST, not a graph. `StateGraph` is welded to the animation state machine's context and to clips, and
 * generalizing a react-flow canvas is its own project — whereas the rows below are the same shape the
 * sound effect rack already uses, and they get the condition tree for free because that is now shared.
 *
 * A controller with no states falls back to its own Goal field, so this section is purely additive: an
 * empty machine is exactly the behaviour that existed before machines did.
 */

const MACHINE_HINT = 'States name a goal; transitions name the condition that leaves one. With no states at all the controller just pursues its Goal field, so adding a machine is never a behaviour change on its own.'
const ENTRY_HINT = 'The state the machine starts in, and the one it falls back to if the held state is deleted.'
const DWELL_HINT = 'Seconds the machine must have spent in the source state before this transition may fire. The guard against a pair that flips every frame.'

const PARAM_TYPES: BehaviorParameterType[] = ['number', 'boolean', 'trigger']

interface Props {
  node: ControllerNode
  onChange: () => void
}

export default function BehaviorEditor({ node, onChange }: Props) {
  // The machine is read straight off the node and written back whole. It is small — a handful of states
  // — so there is nothing to gain from a finer-grained store, and one path means one place to be wrong.
  const [version, setVersion] = useState(0)
  const machine = node.behavior
  // A brain's layers, for the source picker's Layer time and Layer state (the AI Brain tab's; none elsewhere).
  const { layers: brainLayers, baseStates: brainBase, asset: brainAsset } = useAiEditor()
  const layers = brainAsset ? brainLayers : (machine.layers ?? []).map(l => ({ name: l.name, states: l.states.map(s => s.name) }))
  const baseStates = brainAsset ? brainBase : machine.states.map(s => s.name)

  const apply = (next: BehaviorMachine) => {
    node.behavior = parseBehaviorMachine(next)
    setVersion(v => v + 1)
    onChange()
  }
  void version

  // Offered to the source picker so a machine can gate on a fuzzy output. Derived from what the
  // model actually writes, so an output that no rule produces is never suggested.
  const fuzzyOutputs = useMemo(
    () => Array.from(new Set(node.fuzzy.rules.map(r => r.variable))), [node.fuzzy])

  const params: ConditionParam[] = useMemo(() => machine.parameters.map(p => ({
    name: p.name,
    type: p.type === 'boolean' ? 'bool' : p.type === 'trigger' ? 'trigger' : 'float',
  })), [machine])

  const patchState = (name: string, patch: Partial<BehaviorState>) =>
    apply({ ...machine, states: machine.states.map(s => (s.name === name ? { ...s, ...patch } : s)) })

  const patchParam = (index: number, patch: Partial<BehaviorParameter>) =>
    apply({ ...machine, parameters: machine.parameters.map((p, i) => (i === index ? { ...p, ...patch } : p)) })

  const patchTransition = (index: number, patch: Partial<BehaviorTransition>) =>
    apply({ ...machine, transitions: machine.transitions.map((t, i) => (i === index ? { ...t, ...patch } : t)) })

  /** A name nothing is using yet. State names are what transitions reference, so they must be unique. */
  const uniqueName = (base: string, taken: string[]) => {
    if (!taken.includes(base)) return base
    for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`
  }

  if (machine.states.length === 0) {
    return (
      <div className='mt-2'>
        <p className={hintClass}>{MACHINE_HINT}</p>
        <Button size='sm' className='mt-1'
          onClick={() => apply({
            parameters: [],
            states: [{ name: 'Idle', goal: 'idle', isEntry: true }],
            transitions: [],
          })}>
          Add a behaviour machine
        </Button>
      </div>
    )
  }

  return (
    <DocScope page='editor/ai-brains'>
    <div>
      <SectionTitle title='Parameters' className='mt-3 mb-1' />
      <div className='flex flex-col gap-1'>
        {machine.parameters.map((p, i) => (
          <div key={i} className='rounded border border-border bg-control/30 p-1.5 flex flex-col gap-1'>
            <div className='flex items-center gap-1'>
              <TextInput className='flex-1 min-w-0' value={p.name}
                onChange={(name) => patchParam(i, { name })} />
              <Select className='w-[86px]' value={p.type}
                onChange={(e) => patchParam(i, { type: e.target.value as BehaviorParameterType })}>
                {PARAM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </Select>
              <ButtonWithConfirm variant='remove'
                onClick={() => apply({ ...machine, parameters: machine.parameters.filter((_, x) => x !== i) })}>✕</ButtonWithConfirm>
            </div>
            <ParamSourcePicker source={p.source} fuzzyOutputs={fuzzyOutputs} layers={layers} baseStates={baseStates}
              onChange={(source) => patchParam(i, { source })} />
          </div>
        ))}
        <Button size='sm' variant='ghost'
          onClick={() => apply({
            ...machine,
            parameters: [...machine.parameters, {
              name: uniqueName('param', machine.parameters.map(p => p.name)),
              type: 'number', default: 0, source: { kind: 'builtin', name: 'planarSpeed' },
            }],
          })}>
          + Parameter
        </Button>
      </div>

      <SectionTitle title='States' className='mt-3 mb-1' />
      <div className='flex flex-col gap-1'>
        {machine.states.map(s => (
          <div key={s.name} className='rounded border border-border bg-control/30 p-1.5 flex flex-col gap-1'>
            <div className='flex items-center gap-1'>
              <TextInput className='flex-1 min-w-0' value={s.name}
                onChange={(name) => {
                  const trimmed = name.trim()
                  if (!trimmed || trimmed === s.name) return
                  const unique = uniqueName(trimmed, machine.states.filter(x => x.name !== s.name).map(x => x.name))
                  // Transitions address states BY NAME, so a rename has to carry them along or every
                  // transition touching this state is silently dropped by the tolerant reader.
                  apply({
                    ...machine,
                    states: machine.states.map(x => (x.name === s.name ? { ...x, name: unique } : x)),
                    transitions: machine.transitions.map(t => ({
                      ...t,
                      from: t.from === s.name ? unique : t.from,
                      to: t.to === s.name ? unique : t.to,
                    })),
                  })
                }} />
              <Select className='w-[92px]' value={s.goal}
                onChange={(e) => patchState(s.name, { goal: e.target.value as AiGoal })}>
                {AI_GOALS.map(g => <option key={g} value={g}>{g}</option>)}
              </Select>
              <ButtonWithConfirm variant='remove'
                onClick={() => apply({
                  ...machine,
                  states: machine.states.filter(x => x.name !== s.name),
                  transitions: machine.transitions.filter(t => t.from !== s.name && t.to !== s.name),
                })}>✕</ButtonWithConfirm>
            </div>
            <div className='flex items-center gap-2'>
              <Toggle label='Entry' checked={s.isEntry === true} title={ENTRY_HINT}
                onChange={(on) => apply({
                  ...machine,
                  // Exactly one entry: flagging a new one clears the old.
                  states: machine.states.map(x => ({ ...x, isEntry: on ? x.name === s.name : (x.name === s.name ? false : x.isEntry) })),
                })} />
              <TextInput className='w-[110px]' value={s.targetKey ?? ''}
                title='Blackboard key for this state’s target. Empty uses the controller’s own.'
                onChange={(targetKey) => patchState(s.name, { targetKey: targetKey || undefined })} />
            </div>
            <Slider label='Speed' min={0} max={1} step={0.05} value={s.speedScale ?? 1}
              labelClassName='w-[52px]'
              onChange={(v) => patchState(s.name, { speedScale: v })} />
            {s.goal === 'strafe' && <StrafeRows state={s} onChange={patch => patchState(s.name, patch)} />}
            <OutputRows outputs={s.outputs ?? []} onChange={outputs => patchState(s.name, { outputs: outputs.length ? outputs : undefined })} />
          </div>
        ))}
        <Button size='sm' variant='ghost'
          onClick={() => apply({
            ...machine,
            states: [...machine.states, {
              name: uniqueName('State', machine.states.map(s => s.name)), goal: 'idle',
            }],
          })}>
          + State
        </Button>
      </div>

      <SectionTitle title='Transitions' className='mt-3 mb-1' />
      <div className='flex flex-col gap-1'>
        {machine.transitions.map((t, i) => (
          <div key={i} className='rounded border border-border bg-control/30 p-1.5 flex flex-col gap-1'>
            <div className='flex items-center gap-1'>
              <Select className='flex-1 min-w-0' value={t.from}
                onChange={(e) => patchTransition(i, { from: e.target.value })}>
                <option value='*'>any state</option>
                {machine.states.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
              </Select>
              <span className={labelClass}>→</span>
              <Select className='flex-1 min-w-0' value={t.to}
                onChange={(e) => patchTransition(i, { to: e.target.value })}>
                {machine.states.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
              </Select>
              <ButtonWithConfirm variant='remove'
                onClick={() => apply({ ...machine, transitions: machine.transitions.filter((_, x) => x !== i) })}>✕</ButtonWithConfirm>
            </div>
            <Slider label='Min dwell' min={0} max={5} step={0.05} value={t.minDwell ?? 0}
              labelClassName='w-[68px]' title={DWELL_HINT}
              onChange={(v) => patchTransition(i, { minDwell: v > 0 ? v : undefined })} />
            {(t.from === '*' || t.from === t.to) && (
              <span title='May enter the state it leaves: it starts over, its time back to 0 (another knock while hurt starts the hurt over)'>
                <Toggle label='restarts' checked={!!t.restart} onChange={on => patchTransition(i, { restart: on || undefined })} />
              </span>
            )}
            <ConditionTreeView
              params={params}
              node={t.condition ?? emptyConditionGroup()}
              onChange={(condition) => patchTransition(i, { condition })}
            />
          </div>
        ))}
        <Button size='sm' variant='ghost' disabled={machine.states.length < 2}
          title={machine.states.length < 2 ? 'Add a second state first' : undefined}
          onClick={() => apply({
            ...machine,
            transitions: [...machine.transitions, {
              from: machine.states[0].name, to: machine.states[1].name, condition: emptyConditionGroup(),
            }],
          })}>
          + Transition
        </Button>
      </div>

      <div className='mt-2'>
        <ButtonWithConfirm onClick={() => apply({ parameters: [], states: [], transitions: [] })}>
          Remove the machine
        </ButtonWithConfirm>
      </div>
    </div>
    </DocScope>
  )
}

const STRAFE_HINT = 'Which way it steps round the target: Auto steps off the target’s path (away from the way it crosses the line to it); Left or Right as it faces the target.'
const KEEP_HINT = 'The distance it keeps from the target while it steps, closing in or backing off toward it (0: any).'

/** A strafe state's side and the distance it keeps. */
function StrafeRows({ state, onChange }: { state: BehaviorState; onChange: (patch: Partial<BehaviorState>) => void }) {
  return (
    <div className='flex items-center gap-1'>
      <span className={labelClass} title={STRAFE_HINT}>Side</span>
      <Select className='w-[72px]' value={state.strafeSide ?? 'auto'} title={STRAFE_HINT}
        onChange={e => onChange({ strafeSide: e.target.value === 'auto' ? undefined : e.target.value as StrafeSide })}>
        <option value='auto'>Auto</option>
        <option value='left'>Left</option>
        <option value='right'>Right</option>
      </Select>
      <Slider className='flex-1 min-w-0' label='Keep' min={0} max={30} step={0.5} value={state.strafeDistance ?? 0}
        labelClassName='w-[36px]' title={KEEP_HINT}
        onChange={v => onChange({ strafeDistance: v > 0 ? v : undefined })} />
    </div>
  )
}

const OUTPUT_HINT = 'A field of the pawn this state sets while it is held: a script’s field (preferredWeapon, hurt) or a property. Held, it goes back to what it was once no state sets it; Once, it is set as the state is entered and left as it is.'

/** A state's outputs: field, value, held or once. */
function OutputRows({ outputs, onChange }: { outputs: BehaviorOutput[]; onChange: (outputs: BehaviorOutput[]) => void }) {
  const patch = (i: number, p: Partial<BehaviorOutput>) => onChange(outputs.map((o, x) => x === i ? { ...o, ...p } : o))
  return (
    <div className='flex flex-col gap-1'>
      {outputs.map((o, i) => (
        <div key={i} className='flex items-center gap-1'>
          <span className={labelClass} title={OUTPUT_HINT}>Sets</span>
          <TextInput className='flex-1 min-w-0' value={o.field} title='The pawn’s field' onChange={field => patch(i, { field: field.trim() })} />
          <TextInput className='w-[52px]' value={String(o.value)} title='The value: a number, or true / false'
            onChange={v => patch(i, { value: v === 'true' ? true : v === 'false' ? false : (parseFloat(v) || 0) })} />
          <span title='Held: set every frame the state is held. Once: set as it is entered'>
            <Toggle label='held' checked={o.hold !== false} onChange={on => patch(i, { hold: on ? undefined : false })} />
          </span>
          <ButtonWithConfirm variant='remove' onClick={() => onChange(outputs.filter((_, x) => x !== i))}>✕</ButtonWithConfirm>
        </div>
      ))}
      <Button size='sm' variant='ghost' title={OUTPUT_HINT}
        onClick={() => onChange([...outputs, { field: 'field', value: 1 }])}>+ Output</Button>
    </div>
  )
}

/** Where one parameter reads its value from. */
