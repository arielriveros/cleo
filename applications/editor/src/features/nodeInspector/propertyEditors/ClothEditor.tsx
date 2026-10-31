import { useEffect, useState } from 'react'
import type { ClothNode, ClothOptions, ClothPinEdge } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { NumberInput, PropertyRow, PropertyTable, SegmentedControl, Select, Slider, Toggle } from '@cleo/app-kit/ui'
import { ClothIcon } from '../sectionIcons'
import { useEventBus } from '../../EventBusContext'

// The Cloth inspector. The panel hangs in the node's local XY plane, so where it hangs and which way it
// faces are the node's transform — the gizmo places it, and there is no vector here.

const EDGES: { value: ClothPinEdge; label: string; title: string }[] = [
  { value: 'top', label: 'Top', title: 'A cape or a banner: the top edge is held' },
  { value: 'left', label: 'Left', title: 'A flag: the left edge is held along its pole' },
  { value: 'none', label: 'None', title: 'Nothing is held: the cloth falls' },
]

/** Humanoid slots the held edge can ride on (any bone name works too, through the script API). */
const BONES: { value: string; label: string }[] = [
  { value: '', label: 'This node' },
  { value: 'chest', label: 'Chest' },
  { value: 'spine', label: 'Spine' },
  { value: 'neck', label: 'Neck' },
  { value: 'hips', label: 'Hips' },
]

export default function ClothEditor(props: { node: ClothNode }) {
  const eventEmitter = useEventBus()
  const read = () => ({ ...props.node.options })
  const [v, setV] = useState(read)
  useEffect(() => { setV(read()) }, [props.node])

  const set = (patch: ClothOptions) => {
    props.node.setOptions(patch)
    setV(read())
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  }

  return (
    <Collapsable title='Cloth' icon={<ClothIcon />} persistKey='clothEditor'>
      <div className='p-2 flex flex-col gap-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Enabled' divider>
            <Toggle checked={v.enabled} onChange={enabled => set({ enabled })} />
          </PropertyRow>
          <PropertyRow label='Width' divider>
            <NumberInput value={v.width} min={0.05} step={0.05} onChange={width => set({ width })} />
          </PropertyRow>
          <PropertyRow label='Height' divider>
            <NumberInput value={v.height} min={0.05} step={0.05} onChange={height => set({ height })} />
          </PropertyRow>
          <PropertyRow label='Columns' divider>
            <NumberInput value={v.columns} min={2} max={64} step={1} onChange={columns => set({ columns })} />
          </PropertyRow>
          <PropertyRow label='Rows' divider>
            <NumberInput value={v.rows} min={2} max={64} step={1} onChange={rows => set({ rows })} />
          </PropertyRow>
          <PropertyRow label='Held Edge' divider>
            <SegmentedControl value={v.pinEdge} onChange={pinEdge => set({ pinEdge })} options={EDGES} size='sm' grow />
          </PropertyRow>
          <PropertyRow label='Ride On' divider>
            <Select value={v.bone} onChange={e => set({ bone: e.target.value })}>
              {BONES.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
            </Select>
          </PropertyRow>
          <PropertyRow label='Stiffness' divider>
            <Slider min={0} max={1} step={0.01} value={v.stiffness} onChange={stiffness => set({ stiffness })} />
          </PropertyRow>
          <PropertyRow label='Bend' divider>
            <Slider min={0} max={1} step={0.01} value={v.bend} onChange={bend => set({ bend })} />
          </PropertyRow>
          <PropertyRow label='Damping' divider>
            <Slider min={0} max={1} step={0.01} value={v.damping} onChange={damping => set({ damping })} />
          </PropertyRow>
          <PropertyRow label='Mass' divider>
            <NumberInput value={v.mass} min={0.01} step={0.1} onChange={mass => set({ mass })} />
          </PropertyRow>
          <PropertyRow label='Thickness' divider>
            <NumberInput value={v.thickness} min={0} step={0.01} onChange={thickness => set({ thickness })} />
          </PropertyRow>
          <PropertyRow label='Wind Response' divider>
            <Slider min={0} max={3} step={0.05} value={v.windResponse} onChange={windResponse => set({ windResponse })} />
          </PropertyRow>
          <PropertyRow label='Collide With Character'>
            <Toggle checked={v.collideWithOwner} onChange={collideWithOwner => set({ collideWithOwner })} />
          </PropertyRow>
        </PropertyTable>
      </div>
    </Collapsable>
  )
}
