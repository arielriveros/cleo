import { useState } from 'react'
import { ParticleSystemNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Button, DocScope, Hint, NumberInput, PropertyTable } from '@cleo/app-kit/ui'
import { ParticlesIcon } from '../sectionIcons'
import FollowLightRows from './FollowLightRows'
import { DeclaredSection } from '../../properties/DeclaredSections'
import { useEventBus } from '../../EventBusContext'
import ParticleSystemSlot from './ParticleSystemSlot'

// The Particle System node inspector: how THIS instance plays an effect. What the effect is — its
// emitters and modules — belongs to the .vfx asset and is edited in the particle editor, reachable
// through the slot above.
//
// Its rows are the node's declared properties (src/properties/effects.ts); the card adds the effect's slot,
// Follow Light and the transport.

export default function ParticleSystemEditor(props: { node: ParticleSystemNode }) {
  const eventEmitter = useEventBus()

  // Play state lives on the node, which React cannot observe.
  const [, force] = useState(0)
  const transport = (fn: () => void) => { fn(); force(x => x + 1) }
  const [burst, setBurst] = useState(25)

  const emitters = props.node.system.emitters

  // Documented with the particle editor ("In a scene"), next to the asset this node plays.
  return (
    <DocScope page='editor/particles' section='in-a-scene'>
    <Collapsable title='Particle System' doc='editor/particles#in-a-scene' icon={<ParticlesIcon />} persistKey='particleSystemEditor'>
      <div className='p-2 flex flex-col gap-2'>
        <ParticleSystemSlot node={props.node} onChange={() => force(x => x + 1)} />

        <DeclaredSection node={props.node} title='' skip={['tint']} />
        <PropertyTable columns={['45%', '55%']}>
          <FollowLightRows node={props.node} target={props.node}
            onChange={() => eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })} />
        </PropertyTable>
        <DeclaredSection node={props.node} title='' keys={['tint']} />

        <div className='flex items-center gap-1 flex-wrap'>
          <Button size='sm' variant='subtle' onClick={() => transport(() => props.node.restart())} title='Clear and play from the start'>⟲ Restart</Button>
          <Button size='sm' variant='subtle' onClick={() => transport(() => props.node.play())} title='Start emitting'>▶ Play</Button>
          <Button size='sm' variant='subtle' onClick={() => transport(() => props.node.stop())} title='Stop emitting; live particles finish their lives'>■ Stop</Button>
          <Button size='sm' variant='subtle' onClick={() => transport(() => props.node.stop(true))} title='Stop and remove every particle'>✕ Clear</Button>
        </div>
        <div className='flex items-center gap-1'>
          <div className='w-20'><NumberInput value={burst} min={1} step={1} onChange={v => setBurst(Math.max(1, Math.floor(v)))} /></div>
          <Button size='sm' variant='subtle' onClick={() => transport(() => props.node.burst(burst))} title='Emit this many particles at once from every emitter'>Burst</Button>
          <Hint>{props.node.isPlaying ? 'Playing' : props.node.isAlive ? 'Finishing' : 'Stopped'} · {emitters.length} emitter{emitters.length === 1 ? '' : 's'}</Hint>
        </div>
      </div>
    </Collapsable>
    </DocScope>
  )
}
