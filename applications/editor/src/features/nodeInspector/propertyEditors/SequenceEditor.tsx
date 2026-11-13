import { useEffect, useState } from 'react'
import type { SequenceNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { PropertyTable, PropertyRow, Toggle } from '@cleo/app-kit/ui'
import { useEventBus } from '../../EventBusContext'
import { useCleoEngine } from '../../EngineContext'
import NodeRefInput from '../NodeRefInput'
import { SequenceIcon } from '../../sceneInspector/nodeIcons'
import SequenceSlot from './SequenceSlot'
import { useInspectorLock } from '../inspectorLock'

/**
 * A Sequence node's card: which `.sequence` asset it plays, whether it starts by itself, and which scene node
 * fills each of the sequence's slots here (overriding the node the sequence was authored against). The
 * timeline itself is edited in Sequencer mode, which the slot's Edit button opens.
 */
export default function SequenceEditor(props: { node: SequenceNode }) {
  const eventEmitter = useEventBus()
  const { editorScene } = useCleoEngine()
  const lock = useInspectorLock()
  const [, setVersion] = useState(0)
  const bump = () => setVersion(v => v + 1)
  useEffect(bump, [props.node])
  useEffect(() => {
    const on = (e: any) => { if (e?.node === props.node) bump() }
    eventEmitter.on('SCENE_CHANGED', on)
    return () => { eventEmitter.off('SCENE_CHANGED', on) }
  }, [eventEmitter, props.node])

  const node = props.node
  const seq = node.sequence
  const changed = () => {
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node })
    bump()
  }
  const slotNode = (id: string | undefined) => (id ? editorScene.getNodeById(id) : undefined)

  return (
    <Collapsable title='Sequence' icon={<SequenceIcon />} persistKey='sequence'>
      <div className='w-full p-2 flex flex-col gap-2'>
        <SequenceSlot node={node} onChange={bump} />
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Autoplay' divider={seq.slots.length > 0}>
            <Toggle checked={node.autoplay} disabled={lock.locked} onChange={on => { node.autoplay = on; changed() }} />
          </PropertyRow>
          {seq.slots.map((slot, i) => {
            const authored = slotNode(slot.nodeId)
            const fallback = authored ? `(${authored.name})` : slot.path ? `(finds "${slot.path}")` : '(unbound)'
            return (
              <PropertyRow key={slot.id} label={slot.name} divider={i === seq.slots.length - 1 ? false : undefined}>
                <NodeRefInput
                  value={node.bindings[slot.id] ?? null}
                  scene={editorScene}
                  disabled={lock.locked}
                  filter={n => n !== node && (!slot.nodeType || n.nodeType === slot.nodeType || slot.nodeType === 'node')}
                  placeholder={fallback}
                  onChange={id => { node.bind(slot.id, id); changed() }} />
              </PropertyRow>
            )
          })}
        </PropertyTable>
      </div>
    </Collapsable>
  )
}
