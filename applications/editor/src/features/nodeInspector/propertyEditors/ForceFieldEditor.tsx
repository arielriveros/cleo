import { useEffect, useState } from 'react'
import { ForceFieldNode, FORCE_FIELD_PRESETS, type ForceFieldPreset } from 'cleo'
import type { ForceFieldKind, ForceFieldShape } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { NumberInput, PresetMenu, PropertyRow, PropertyTable, SegmentedControl, Select, Slider, Toggle, VectorInput } from '@cleo/app-kit/ui'
import { ForceFieldIcon } from '../sectionIcons'
import { useEventBus } from '../../EventBusContext'

// The Force Field inspector. Direction (wind) and axis (vortex) are the node's local +Y, so they are set
// by rotating the node — the gizmo is the direction control, and there is deliberately no vector here.
// "Affects wind" makes the field local WIND as well (core/wind/windField.ts): foliage bends to it and
// Scene-wind particles ride it, and its strength reads as air speed rather than acceleration.

/** What strength means for each kind once the field moves the air. */
const WIND_STRENGTH_HINTS: Record<ForceFieldKind, string> = {
  directional: 'Air speed along local +Y, m/s. Rotate the node to aim it across the ground.',
  radial: 'Air speed toward the centre, m/s; negative is a blast outward.',
  vortex: 'Air speed round local +Y, m/s; negative turns the other way. The eye, a fifth of the size, is calm.',
  turbulence: 'Eddy speed, m/s.',
  drag: 'The share of the wind it blocks: 1 is still air inside, 0.5 halves it.',
}

const KINDS: { value: ForceFieldKind; label: string; hint: string }[] = [
  { value: 'directional', label: 'Wind', hint: 'Pulls particle velocity toward local +Y × strength (m/s).' },
  { value: 'radial', label: 'Radial', hint: 'Accelerates toward the centre; negative strength pushes away.' },
  { value: 'vortex', label: 'Vortex', hint: 'Spins particles around the local +Y axis.' },
  { value: 'turbulence', label: 'Turbulence', hint: 'Curl-noise swirl at the given frequency.' },
  { value: 'drag', label: 'Drag', hint: 'Slows particles down inside the volume.' },
]

const SHAPES: { value: ForceFieldShape; label: string; title: string }[] = [
  { value: 'global', label: 'Global', title: 'Affects every particle in the scene' },
  { value: 'sphere', label: 'Sphere', title: 'Affects particles inside a radius' },
  { value: 'box', label: 'Box', title: 'Affects particles inside an axis-aligned box' },
]

export default function ForceFieldEditor(props: { node: ForceFieldNode }) {
  const eventEmitter = useEventBus()
  const read = () => ({
    kind: props.node.kind, shape: props.node.shape, strength: props.node.strength, radius: props.node.radius,
    extents: [...props.node.extents], falloff: props.node.falloff, frequency: props.node.frequency,
    enabled: props.node.enabled, affectsWind: props.node.affectsWind,
  })
  const [v, setV] = useState(read)
  useEffect(() => { setV(read()) }, [props.node])

  const set = (patch: Partial<ReturnType<typeof read>>) => {
    const n = props.node
    if (patch.kind !== undefined) n.kind = patch.kind
    if (patch.shape !== undefined) n.shape = patch.shape
    if (patch.strength !== undefined) n.strength = patch.strength
    if (patch.radius !== undefined) n.radius = patch.radius
    if (patch.extents !== undefined) n.extents = patch.extents as [number, number, number]
    if (patch.falloff !== undefined) n.falloff = patch.falloff
    if (patch.frequency !== undefined) n.frequency = patch.frequency
    if (patch.enabled !== undefined) n.enabled = patch.enabled
    if (patch.affectsWind !== undefined) n.affectsWind = patch.affectsWind
    setV(read())
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  }

  const applyPreset = (p: ForceFieldPreset) => {
    props.node.applyPreset(p)
    setV(read())
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  }

  const kind = KINDS.find(k => k.value === v.kind)
  return (
    <Collapsable title='Force Field' icon={<ForceFieldIcon />} persistKey='forceFieldEditor'
      right={<PresetMenu presets={FORCE_FIELD_PRESETS} onApply={applyPreset} title='Force presets — kind, shape and strength (the Wind ones move the air); size and aim stay yours' />}>
      <div className='p-2 flex flex-col gap-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Enabled' divider>
            <Toggle checked={v.enabled} onChange={enabled => set({ enabled })} />
          </PropertyRow>
          <PropertyRow label='Affects wind' divider
            hint='Also move the scene’s air: foliage bends to this field, Scene-wind particles ride it, and scripts read it with windAt. Selecting it shows the wind field in the viewport.'>
            <Toggle checked={v.affectsWind} onChange={affectsWind => set({ affectsWind })} />
          </PropertyRow>
          <PropertyRow label='Force' hint={kind?.hint} divider>
            <Select value={v.kind} onChange={e => set({ kind: e.target.value as ForceFieldKind })}>
              {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
            </Select>
          </PropertyRow>
          <PropertyRow label='Strength' divider
            hint={v.affectsWind ? WIND_STRENGTH_HINTS[v.kind] : v.kind === 'directional' ? 'Wind speed, m/s.' : 'm/s² (drag: per second).'}>
            {v.affectsWind && v.kind === 'drag'
              ? <Slider min={0} max={1} step={0.01} value={Math.min(1, Math.max(0, v.strength))} onChange={strength => set({ strength })} />
              : <NumberInput value={v.strength} step={0.5} onChange={strength => set({ strength })} />}
          </PropertyRow>
          {v.kind === 'turbulence' && (
            <PropertyRow label='Frequency' hint='Noise features per metre. Lower is broader swirls.' divider>
              <NumberInput value={v.frequency} min={0.001} step={0.05} onChange={frequency => set({ frequency })} />
            </PropertyRow>
          )}
          <PropertyRow label='Shape' divider>
            <SegmentedControl value={v.shape} onChange={shape => set({ shape })} options={SHAPES} size='sm' grow />
          </PropertyRow>
          {v.shape === 'sphere' && (
            <PropertyRow label='Radius' hint='Metres, before the node scale.' divider>
              <NumberInput value={v.radius} min={0.01} step={0.25} onChange={radius => set({ radius })} />
            </PropertyRow>
          )}
          {v.shape === 'box' && (
            <PropertyRow label='Half extents' hint='Metres, before the node scale. Axis-aligned in the world.' divider>
              <VectorInput value={v.extents} min={0} step={0.1} onChange={extents => set({ extents })} />
            </PropertyRow>
          )}
          {v.shape !== 'global' && (
            <PropertyRow label='Falloff' hint='The fraction of the shape, from its edge inward, over which the force fades in.'>
              <Slider min={0} max={1} step={0.01} value={v.falloff} onChange={falloff => set({ falloff })} />
            </PropertyRow>
          )}
        </PropertyTable>
      </div>
    </Collapsable>
  )
}
