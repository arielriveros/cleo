import { PROCESSOR_KINDS } from 'cleo'
import type { Processor, ProcessorKind } from 'cleo'
import { Button, NumberInput, Select, Toggle, hintClass, labelClass } from '../../components/ui'

/**
 * The ordered processor chain on a binding or an action: add, remove, reorder, tune.
 *
 * This is the same UI problem `EffectRackEditor` solves for a sound's effect rack — an ordered list of
 * a discriminated union, each variant with its own parameters — and it deliberately reads the same way,
 * because it behaves the same way: ORDER IS MEANING. A deadzone after a scale is not the same patch as
 * a deadzone before one, so the arrows are a real edit rather than cosmetic sorting.
 */

const KIND_LABELS: Record<ProcessorKind, string> = {
  deadzone: 'Deadzone (per axis)',
  radialDeadzone: 'Deadzone (radial)',
  scale: 'Scale',
  invert: 'Invert',
  curve: 'Curve',
  smooth: 'Smooth',
  normalize: 'Normalize',
}

const KIND_HINTS: Record<ProcessorKind, string> = {
  deadzone: 'Silences each axis near centre and rescales the rest, so there is no step at the edge.',
  radialDeadzone: 'The same, on the vector length — a circular dead region, so a resting stick cannot drift diagonally.',
  scale: 'Multiplies. This is sensitivity.',
  invert: 'Flips an axis. Per axis, because inverting look-Y is a preference and look-X almost never is.',
  curve: 'Above 1 gives finer control near centre; below 1 makes it twitchier.',
  smooth: 'Time constant in seconds. Frame-rate independent.',
  normalize: 'Clamps to unit length. Evens out a keyboard diagonal without amplifying a half-pushed stick.',
}

interface Props {
  chain: readonly Processor[]
  onAdd(kind: ProcessorKind): void
  onRemove(index: number): void
  onUpdate(index: number, processor: Processor): void
  onMove(index: number, delta: number): void
}

export default function ProcessorList({ chain, onAdd, onRemove, onUpdate, onMove }: Props) {
  return (
    <div className='flex flex-col gap-1'>
      {chain.map((processor, index) => (
        <div key={`${processor.kind}-${index}`} className='rounded border border-border bg-control/40 p-1.5'>
          <div className='flex items-center gap-1'>
            <span className={labelClass}>{KIND_LABELS[processor.kind]}</span>
            <div className='ml-auto flex items-center gap-0.5'>
              <Button size='sm' variant='ghost' title='Move earlier' disabled={index === 0}
                onClick={() => onMove(index, -1)}>↑</Button>
              <Button size='sm' variant='ghost' title='Move later' disabled={index === chain.length - 1}
                onClick={() => onMove(index, 1)}>↓</Button>
              <Button size='sm' variant='ghost' title='Remove' onClick={() => onRemove(index)}>✕</Button>
            </div>
          </div>
          <ProcessorParams processor={processor} onChange={p => onUpdate(index, p)} />
          <p className={hintClass}>{KIND_HINTS[processor.kind]}</p>
        </div>
      ))}

      <Select
        value=''
        onChange={e => { if (e.target.value) onAdd(e.target.value as ProcessorKind) }}
        title='Add a processor to the end of the chain'
      >
        <option value=''>Add processor…</option>
        {PROCESSOR_KINDS.map(kind => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
      </Select>
    </div>
  )
}

/** The parameter row for one variant. Exhaustive over the union, so a new processor cannot be forgotten. */
function ProcessorParams({ processor, onChange }: { processor: Processor; onChange(p: Processor): void }) {
  switch (processor.kind) {
    case 'deadzone':
    case 'radialDeadzone':
      return (
        <div className='flex items-center gap-2 mt-1'>
          <label className={labelClass}>min</label>
          <NumberInput className='w-16' step={0.01} value={processor.min}
            onChange={min => onChange({ ...processor, min })} />
          <label className={labelClass}>max</label>
          <NumberInput className='w-16' step={0.01} value={processor.max}
            onChange={max => onChange({ ...processor, max })} />
        </div>
      )
    case 'scale':
      return (
        <div className='flex items-center gap-2 mt-1'>
          <label className={labelClass}>factor</label>
          <NumberInput className='w-20' step={0.1} value={processor.factor}
            onChange={factor => onChange({ ...processor, factor })} />
        </div>
      )
    case 'invert':
      return (
        <div className='flex items-center gap-3 mt-1'>
          <Toggle label='X' checked={processor.x} onChange={x => onChange({ ...processor, x })} />
          <Toggle label='Y' checked={processor.y} onChange={y => onChange({ ...processor, y })} />
        </div>
      )
    case 'curve':
      return (
        <div className='flex items-center gap-2 mt-1'>
          <label className={labelClass}>exponent</label>
          <NumberInput className='w-20' step={0.1} value={processor.exponent}
            onChange={exponent => onChange({ ...processor, exponent })} />
        </div>
      )
    case 'smooth':
      return (
        <div className='flex items-center gap-2 mt-1'>
          <label className={labelClass}>seconds</label>
          <NumberInput className='w-20' step={0.01} value={processor.seconds}
            onChange={seconds => onChange({ ...processor, seconds })} />
        </div>
      )
    case 'normalize':
      return null
  }
}
