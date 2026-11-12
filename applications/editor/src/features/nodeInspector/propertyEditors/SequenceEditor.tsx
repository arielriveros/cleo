import { useEffect, useState } from 'react'
import type { SequenceNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Button, PropertyTable, PropertyRow, Toggle } from '@cleo/app-kit/ui'
import { useEventBus } from '../../EventBusContext'
import { useCleoEngine } from '../../EngineContext'
import NodeRefInput from '../NodeRefInput'
import { SequenceIcon } from '../../sceneInspector/nodeIcons'

/**
 * A Sequence node's card: what it plays, whether it starts by itself, and which scene node fills each of the
 * sequence's slots. The timeline itself is edited in the Sequencer panel.
 */
export default function SequenceEditor(props: { node: SequenceNode }) {
  const eventEmitter = useEventBus()
  const { editorScene } = useCleoEngine()
  const [, setVersion] = useState(0)
  const bump = () => setVersion(v => v + 1)
  useEffect(bump, [props.node])
  // The Sequencer edits the same node: show its slots as they change there.
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

  return (
    <Collapsable title='Sequence' icon={<SequenceIcon />} persistKey='sequence'>
      <div className='w-full p-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Sequence'>
            <span className='text-ui-sm'>{seq.name}</span>
          </PropertyRow>
          <PropertyRow label='Length'>
            <span className='text-ui-sm'>{`${seq.duration.toFixed(1)} s, ${seq.tracks.length} tracks${seq.loop ? ', loops' : ''}`}</span>
          </PropertyRow>
          <PropertyRow label='Autoplay' divider={seq.slots.length > 0}>
            <Toggle checked={node.autoplay} onChange={on => { node.autoplay = on; changed() }} />
          </PropertyRow>
          {seq.slots.map((slot, i) => (
            <PropertyRow key={slot.id} label={slot.name} divider={i === seq.slots.length - 1 ? false : undefined}>
              <NodeRefInput
                value={node.bindings[slot.id] ?? null}
                scene={editorScene}
                filter={n => n !== node && (!slot.nodeType || n.nodeType === slot.nodeType || slot.nodeType === 'node')}
                placeholder={slot.path ? `(finds "${slot.path}")` : '(unbound)'}
                onChange={id => { node.bind(slot.id, id); changed() }} />
            </PropertyRow>
          ))}
        </PropertyTable>
        <Button size='sm' className='mt-2' title='Show this sequence in the Sequencer, in the bottom strip'
          onClick={() => eventEmitter.emit('FOCUS_BOTTOM_TAB', 'Sequencer')}>Open in Sequencer</Button>
      </div>
    </Collapsable>
  )
}
