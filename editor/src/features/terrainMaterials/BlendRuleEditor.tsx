import type { TerrainBlendRule, TerrainRuleRange } from 'cleo'
import { Hint, NumberInput, Slider, Toggle } from '../../components/ui'

// The editor for one blend rule — where a landscape-material surface appears. Four independent tests,
// multiplied: elevation, slope, the noise that breaks their edges up, and a plain opacity. A disabled test
// passes everywhere, which is why a fresh slot covers the whole layer until it is told otherwise.
//
// Units are the ones an author thinks in and the ones the tooltips promise: metres ABOVE THE LANDSCAPE'S
// ORIGIN (so moving a landscape does not move its snow line) and degrees of slope (0 flat, 90 vertical).

const row = 'flex items-center justify-between gap-2'
const label = 'text-xs text-slate-300'

export interface BlendRuleEditorProps {
  rule: TerrainBlendRule
  /** Called after any mutation; the rule is edited in place. */
  onChange: () => void
  /** The height range of the landscape being authored against, quoted beside the elevation test. */
  elevationHint?: string | null
  /** Hidden for a landscape's BASE surface, which always covers everything under it. */
  showOpacity?: boolean
}

export default function BlendRuleEditor({ rule, onChange, elevationHint, showOpacity = true }: BlendRuleEditorProps) {
  return (
    <div className='space-y-2'>
      <RangeTest name='Elevation' unit='m' step={1} range={rule.elevation} onChange={onChange}
        title='Show this surface only between two heights above the landscape’s origin'
        hint={elevationHint} />
      <RangeTest name='Slope' unit='°' step={1} min={0} max={90} range={rule.slope} onChange={onChange}
        title='Show this surface only on ground within a range of steepness: 0° is flat, 90° is a vertical cliff' />

      <div className='pt-1 border-t border-control space-y-1'>
        <Slider label='Noise' min={0} max={1} step={0.05} value={rule.noise.amount}
          title='Break the rule’s edges up so the transition is irregular rather than a clean band'
          onChange={v => { rule.noise.amount = v; onChange() }} />
        {rule.noise.amount > 0 && (
          <div className={row}>
            <span className={label}>Scale / seed</span>
            <span className='flex gap-1'>
              <NumberInput className='w-16' value={rule.noise.scale} min={0.01} step={1} title='Feature size in metres'
                onChange={v => { rule.noise.scale = Math.max(0.01, v); onChange() }} />
              <NumberInput className='w-14' value={rule.noise.seed} step={1} title='Change it to decorrelate two surfaces using the same scale'
                onChange={v => { rule.noise.seed = v; onChange() }} />
            </span>
          </div>
        )}
        <Slider label='Height blend' min={0} max={1} step={0.05} value={rule.heightBlend}
          title='Let this surface’s height map decide the transition: high spots (gravel, cobbles) poke through first'
          onChange={v => { rule.heightBlend = v; onChange() }} />
        {showOpacity && (
          <Slider label='Opacity' min={0} max={1} step={0.05} value={rule.opacity}
            title='Multiplies the whole rule. Below 1 the surfaces under this one keep showing through.'
            onChange={v => { rule.opacity = v; onChange() }} />
        )}
      </div>
    </div>
  )
}

/** One banded test: fully covered between min and max, fading to nothing over `falloff` outside it. */
function RangeTest({ name, unit, range, onChange, title, hint, step, min, max }: {
  name: string
  unit: string
  range: TerrainRuleRange
  onChange: () => void
  title: string
  hint?: string | null
  step: number
  min?: number
  max?: number
}) {
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
  return (
    <div className='space-y-1'>
      <div className={row}>
        <span className={label} title={title}>{name}</span>
        <Toggle checked={range.enabled} onChange={c => { range.enabled = c; onChange() }} />
      </div>
      {range.enabled && <>
        <div className={row}>
          <span className={`${label} opacity-70`}>Min / max ({unit})</span>
          <span className='flex gap-1'>
            <NumberInput className='w-16' value={range.min} step={step}
              onChange={v => { range.min = clamp(v); onChange() }} />
            <NumberInput className='w-16' value={range.max} step={step}
              onChange={v => { range.max = clamp(v); onChange() }} />
          </span>
        </div>
        <div className={row}>
          <span className={`${label} opacity-70`} title='How far outside the band the surface fades out. 0 is a hard edge.'>Falloff ({unit})</span>
          <NumberInput className='w-16' value={range.falloff} min={0} step={step}
            onChange={v => { range.falloff = Math.max(0, v); onChange() }} />
        </div>
        {hint && <Hint>{hint}</Hint>}
      </>}
    </div>
  )
}
