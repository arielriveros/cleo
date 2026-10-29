import { BEHAVIOR_SENSES } from 'cleo'
import type { BehaviorParameterSource } from 'cleo'
import { Select, TextInput } from '../../../components/ui'

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
}

export default function ParamSourcePicker({ source, onChange, fuzzyOutputs = [] }: Props) {
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
              : { kind: 'const', value: 0 })
        }}>
        <option value='builtin'>Built-in</option>
        <option value='sense'>Sense</option>
        <option value='blackboard'>Blackboard</option>
        <option value='variable'>Variable</option>
        {/* Offered only when a model writes something: a fuzzy source with no outputs reads 0 forever. */}
        {(fuzzyOutputs.length > 0 || source.kind === 'fuzzy') && <option value='fuzzy'>Fuzzy</option>}
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
