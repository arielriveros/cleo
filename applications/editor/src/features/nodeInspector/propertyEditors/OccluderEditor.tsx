import { useEffect, useState } from 'react'
import { OccluderNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { PropertyRow, PropertyTable, Toggle, VectorInput } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../../EngineContext'
import { OccluderIcon } from '../sectionIcons'

// The Occluder inspector. An occluder is a box the renderer's occlusion culling hides things behind
// (graphics/occlusion): it draws nothing and collides with nothing, and it must sit INSIDE solid geometry.

export default function OccluderEditor(props: { node: OccluderNode }) {
  const { eventEmitter } = useCleoEngine()
  const read = () => ({ size: [...props.node.size] as [number, number, number], enabled: props.node.enabled })
  const [v, setV] = useState(read)
  useEffect(() => { setV(read()) }, [props.node])

  const set = (patch: Partial<ReturnType<typeof read>>) => {
    if (patch.size !== undefined) props.node.size = patch.size
    if (patch.enabled !== undefined) props.node.enabled = patch.enabled
    setV(read())
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  }

  return (
    <Collapsable title='Occluder' icon={<OccluderIcon />} persistKey='occluderEditor'>
      <div className='p-2 flex flex-col gap-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Enabled' divider>
            <Toggle checked={v.enabled} onChange={enabled => set({ enabled })} />
          </PropertyRow>
          <PropertyRow label='Size' hint='Full extents in metres, before the node transform (which it follows, rotation included).' divider={false}>
            <VectorInput value={v.size} min={0} step={0.25} onChange={size => set({ size: size as [number, number, number] })} />
          </PropertyRow>
        </PropertyTable>
      </div>
    </Collapsable>
  )
}
