import { LAYER_COUNT, BUILT_IN_LAYERS, layerBit, layerLabel, singleLayerOf, storedMask, isAllLayers } from 'cleo'
import { Field, Popover, Select, Toggle, Button, cn } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../../EngineContext'

// The collision layer pickers: one named layer (a Collider's, a Trigger's or a 2D body's Layer) and a named set of
// layers (a Collides with, a camera rig's Blocked by and See through, a foot IK rig's trace layers, what a 2D AI
// sees). One table of names for 3D and 2D physics alike, the project's (Options ▸ Project ▸ Layers); the
// data stays bits, so an unnamed layer is "Layer N". Each comes bare (`LayerDropdown`, `LayerMaskDropdown`, for a
// PropertyRow) and as a labelled Field row (`LayerSelect`, `LayerMaskSelect`).

/** The project's collision layer names, index 0 being layer 1. */
export function useCollisionLayerNames(): readonly string[] {
  return useCleoEngine().projectSettings.collisionLayers
}

const MIXED = -2

export interface LayerDropdownProps {
  value: number
  onChange: (bit: number) => void
  className?: string
  disabled?: boolean
}

/** One named layer. A value holding several (saved before layers were one each) shows as Mixed until a layer is picked. */
export function LayerDropdown({ value, onChange, className, disabled }: LayerDropdownProps) {
  const names = useCollisionLayerNames()
  const index = singleLayerOf(value)
  return (
    <Select value={index ?? MIXED} disabled={disabled} className={cn('min-w-0 flex-1', className)}
            onChange={e => { const i = Number(e.target.value); if (i >= 0) onChange(layerBit(i)) }}>
      {index === null && <option value={MIXED} disabled>Mixed</option>}
      {Array.from({ length: LAYER_COUNT }, (_, i) => (
        <option key={i} value={i}>{`${i + 1}. ${layerLabel(names, i)}`}</option>
      ))}
    </Select>
  )
}

/** A mask in a few words: "All layers", "None", "Default, Stairs", "All but No Camera", or "5 layers". */
export function layerMaskSummary(names: readonly string[], mask: number): string {
  if (isAllLayers(mask)) return 'All layers'
  const on: string[] = [], off: string[] = []
  for (let i = 0; i < LAYER_COUNT; i++) ((mask & (1 << i)) ? on : off).push(layerLabel(names, i))
  if (on.length === 0) return 'None'
  if (on.length <= 3) return on.join(', ')
  if (off.length <= 3) return `All but ${off.join(', ')}`
  return `${on.length} layers`
}

/**
 * A named set of layers, dropped from a button that sums it up. Every layer on is stored as -1 (all, the
 * layers a project names later included); anything else as just its bits.
 */
export function LayerMaskDropdown({ value, onChange, className, disabled }: LayerDropdownProps) {
  const names = useCollisionLayerNames()
  const summary = layerMaskSummary(names, value)
  const toggle = (i: number, on: boolean) => {
    const bits = isAllLayers(value) ? 0xffff : value & 0xffff
    onChange(storedMask(on ? bits | (1 << i) : bits & ~(1 << i)))
  }
  return (
    <Popover rootClassName={cn('min-w-0 flex-1', className)} align='right' title={summary} disabled={disabled}
             triggerClassName='w-full text-left type-value bg-control text-fg border border-border rounded px-2 py-1 truncate'
             trigger={<span className='block truncate'>{summary}</span>}>
      <div className='p-2 w-[220px] flex flex-col gap-0.5'>
        <div className='flex gap-1 mb-1'>
          <Button size='sm' variant='ghost' onClick={() => onChange(-1)}>All</Button>
          <Button size='sm' variant='ghost' onClick={() => onChange(0)}>None</Button>
        </div>
        {Array.from({ length: LAYER_COUNT }, (_, i) => {
          const named = i < BUILT_IN_LAYERS || !!names[i]?.trim()
          return (
            <Toggle key={i} className={cn('justify-start', !named && 'text-dim')} doc={false}
                    label={`${i + 1}. ${layerLabel(names, i)}`}
                    checked={(value & (1 << i)) !== 0} onChange={on => toggle(i, on)} />
          )
        })}
      </div>
    </Popover>
  )
}

export interface LayerSelectProps {
  label: string
  value: number
  onChange: (bit: number) => void
  hint?: string
  labelClassName?: string
  /** Classes for the row. */
  className?: string
}

/** {@link LayerDropdown} as a labelled row. */
export function LayerSelect({ label, value, onChange, hint, labelClassName, className }: LayerSelectProps) {
  return (
    <Field label={label} labelClassName={labelClassName} hint={hint} className={className}>
      <LayerDropdown value={value} onChange={onChange} />
    </Field>
  )
}

export interface LayerMaskSelectProps extends Omit<LayerSelectProps, 'onChange'> {
  onChange: (mask: number) => void
}

/** {@link LayerMaskDropdown} as a labelled row. */
export function LayerMaskSelect({ label, value, onChange, hint, labelClassName, className }: LayerMaskSelectProps) {
  return (
    <Field label={label} labelClassName={labelClassName} hint={hint} className={className}>
      <LayerMaskDropdown value={value} onChange={onChange} />
    </Field>
  )
}
