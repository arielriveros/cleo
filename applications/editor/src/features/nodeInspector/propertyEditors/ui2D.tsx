import { NumberInput } from '@cleo/app-kit/ui'

// Small inputs the 2D inspectors share: a pair of numbers (a size, an offset, a point). The collision layer pickers are
// the 3D ones (physicsEditors/layerPickers.tsx): the project names one set of layers for both.

export function PairInput(props: { value: [number, number], step?: number, min?: number, onChange: (v: [number, number]) => void }) {
  const clamp = (v: number) => (props.min !== undefined ? Math.max(props.min, v) : v)
  return (
    <span className='flex gap-1'>
      <NumberInput className='w-16' step={props.step ?? 0.1} value={props.value[0]} onChange={(v) => props.onChange([clamp(v), props.value[1]])} />
      <NumberInput className='w-16' step={props.step ?? 0.1} value={props.value[1]} onChange={(v) => props.onChange([props.value[0], clamp(v)])} />
    </span>
  )
}
