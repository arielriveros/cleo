import { NumberInput } from '@cleo/app-kit/ui'

// Small inputs the 2D inspectors share: a pair of numbers (a size, an offset, a point) and a 2D layer mask.

export function PairInput(props: { value: [number, number], step?: number, min?: number, onChange: (v: [number, number]) => void }) {
  const clamp = (v: number) => (props.min !== undefined ? Math.max(props.min, v) : v)
  return (
    <span className='flex gap-1'>
      <NumberInput className='w-16' step={props.step ?? 0.1} value={props.value[0]} onChange={(v) => props.onChange([clamp(v), props.value[1]])} />
      <NumberInput className='w-16' step={props.step ?? 0.1} value={props.value[1]} onChange={(v) => props.onChange([props.value[0], clamp(v)])} />
    </span>
  )
}

/** A bit mask as eight toggles for its low bits: the 2D layers. */
export function LayerBits(props: { value: number, onChange: (v: number) => void }) {
  return (
    <span className='flex gap-0.5'>
      {[0, 1, 2, 3, 4, 5, 6, 7].map(bit => {
        const on = (props.value & (1 << bit)) !== 0
        return (
          <button key={bit} type='button' title={`Layer ${bit + 1}`}
            className={`w-5 h-5 text-ui-xs rounded-sm border ${on ? 'bg-primary text-on-primary border-primary' : 'border-border text-muted'}`}
            onClick={() => props.onChange(on ? props.value & ~(1 << bit) : props.value | (1 << bit))}>{bit + 1}</button>
        )
      })}
    </span>
  )
}
