import { BEHAVIOR_SENSES, REACTION_VALUES } from 'cleo'
import type { BehaviorParameterSource } from 'cleo'
import { Select, TextInput, cn } from '@cleo/app-kit/ui'

/**
 * Where a value comes from: the one picker for every readable in the AI layer.
 *
 * Shared on purpose. The behaviour machine's parameters and a goal evaluator's desirability draw on
 * the same vocabulary, and the engine deliberately reads them through a single function — two copies
 * of this control would be two places for `blackboard` or `sense` to drift into meaning subtly
 * different things in the two brains.
 */

/** Built-ins worth offering. The same measured-motion surface the Animator binds to. */
export const PARAM_BUILTINS = [
  'planarSpeed', 'currentSpeed', 'verticalSpeed', 'isGrounded', 'isFalling', 'isMoving',
  'stillTime', 'movingTime', 'airTime', 'groundedTime', 'groundDistance', 'slopeAngle', 'turnRate',
]

interface Props {
  source: BehaviorParameterSource
  onChange(source: BehaviorParameterSource): void
  /**
   * Names the controller's fuzzy model actually writes. Empty hides the Fuzzy option entirely rather
   * than offering a source that can only ever read 0.
   */
  fuzzyOutputs?: string[]
  /** The brain's layers and their states, and the top level's: offered as Layer time and Layer state. */
  layers?: { name: string; states: string[] }[]
  baseStates?: string[]
}

/** The reaction values a brain can read: the animator's reaction parameters, by the same names. */
const REACTIONS = Object.keys(REACTION_VALUES)

export default function ParamSourcePicker({ source, onChange, fuzzyOutputs = [], layers = [], baseStates = [] }: Props) {
  const layerStates = (name: string) => name ? layers.find(l => l.name === name)?.states ?? [] : baseStates
  return (
    <div className='flex items-center gap-1'>
      <Select className='w-[104px]' value={source.kind}
        onChange={(e) => {
          const kind = e.target.value as BehaviorParameterSource['kind']
          onChange(
            kind === 'builtin' ? { kind, name: PARAM_BUILTINS[0] }
              : kind === 'sense' ? { kind, name: BEHAVIOR_SENSES[0] }
              : kind === 'blackboard' ? { kind, key: 'target' }
              : kind === 'variable' ? { kind, varName: '' }
              : kind === 'fuzzy' ? { kind, name: fuzzyOutputs[0] ?? '' }
              : kind === 'reaction' ? { kind, name: 'knockCount' }
              : kind === 'layerTime' ? { kind, layer: layers[0]?.name ?? '' }
              : kind === 'layerState' ? { kind, layer: layers[0]?.name ?? '', state: (layers[0]?.states ?? baseStates)[0] ?? '' }
              : { kind: 'const', value: 0 })
        }}>
        <option value='builtin'>Built-in</option>
        <option value='sense'>Sense</option>
        <option value='blackboard'>Blackboard</option>
        <option value='variable'>Variable</option>
        {/* Offered only when a model writes something: a fuzzy source with no outputs reads 0 forever. */}
        {(fuzzyOutputs.length > 0 || source.kind === 'fuzzy') && <option value='fuzzy'>Fuzzy</option>}
        <option value='reaction' title='What the pawn’s body is doing: knocked down, staggering, the last hit, how many knocks (a count raises a trigger each time it rises)'>Reaction</option>
        {(layers.length > 0 || source.kind === 'layerTime') && <option value='layerTime' title='Seconds a layer has held its state'>Layer time</option>}
        {(layers.length > 0 || source.kind === 'layerState') && <option value='layerState' title='Whether a layer holds a state now'>Layer state</option>}
        <option value='const'>Constant</option>
      </Select>

      {source.kind === 'builtin' && (
        <Select className='flex-1 min-w-0' value={source.name}
          onChange={(e) => onChange({ kind: 'builtin', name: e.target.value })}>
          {!PARAM_BUILTINS.includes(source.name) && <option value={source.name}>{source.name}</option>}
          {PARAM_BUILTINS.map(b => <option key={b} value={b}>{b}</option>)}
        </Select>
      )}
      {source.kind === 'sense' && (
        <Select className='flex-1 min-w-0' value={source.name}
          onChange={(e) => onChange({ kind: 'sense', name: e.target.value as typeof BEHAVIOR_SENSES[number] })}>
          {BEHAVIOR_SENSES.map(s => <option key={s} value={s}>{s}</option>)}
        </Select>
      )}
      {source.kind === 'blackboard' && (
        <TextInput className='flex-1 min-w-0' value={source.key}
          onChange={(key) => onChange({ kind: 'blackboard', key })} />
      )}
      {source.kind === 'variable' && (
        <TextInput className='flex-1 min-w-0' value={source.varName}
          onChange={(varName) => onChange({ kind: 'variable', varName })} />
      )}
      {source.kind === 'fuzzy' && (
        <Select className='flex-1 min-w-0' value={source.name}
          onChange={(e) => onChange({ kind: 'fuzzy', name: e.target.value })}>
          {/* A name the model no longer writes is kept as an option, so opening the inspector does
              not silently repoint an authored source at a different output. */}
          {!fuzzyOutputs.includes(source.name) && <option value={source.name}>{source.name || '(none)'}</option>}
          {fuzzyOutputs.map(o => <option key={o} value={o}>{o}</option>)}
        </Select>
      )}
      {source.kind === 'reaction' && (
        <Select className='flex-1 min-w-0' value={source.name}
          onChange={(e) => onChange({ kind: 'reaction', name: e.target.value })}>
          {!REACTIONS.includes(source.name) && <option value={source.name}>{source.name}</option>}
          {REACTIONS.map(r => <option key={r} value={r}>{r}</option>)}
        </Select>
      )}
      {(source.kind === 'layerTime' || source.kind === 'layerState') && (
        <Select className='flex-1 min-w-0' value={source.layer}
          title='The layer it reads (Base: the top level)'
          onChange={(e) => onChange(source.kind === 'layerTime'
            ? { kind: 'layerTime', layer: e.target.value }
            : { kind: 'layerState', layer: e.target.value, state: layerStates(e.target.value)[0] ?? source.state })}>
          <option value=''>Base</option>
          {layers.map(l => <option key={l.name} value={l.name}>{l.name}</option>)}
        </Select>
      )}
      {source.kind === 'layerState' && (
        <Select className={cn('w-[92px]', !layerStates(source.layer).includes(source.state) && 'border-warning')} value={source.state}
          title={layerStates(source.layer).includes(source.state) ? undefined : `No state "${source.state}" in this layer: it reads false`}
          onChange={(e) => onChange({ kind: 'layerState', layer: source.layer, state: e.target.value })}>
          {!layerStates(source.layer).includes(source.state) && <option value={source.state}>{source.state ? `${source.state} (missing)` : '(none)'}</option>}
          {layerStates(source.layer).map(s => <option key={s} value={s}>{s}</option>)}
        </Select>
      )}
      {source.kind === 'const' && (
        <TextInput className='flex-1 min-w-0' value={String(source.value)}
          onChange={(v) => onChange({
            kind: 'const',
            value: v === 'true' ? true : v === 'false' ? false : (parseFloat(v) || 0),
          })} />
      )}
    </div>
  )
}
