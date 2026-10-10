import { useEffect, useState } from 'react'
import { ParticleSystemNode } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import { Button, ColorInput, Hint, NumberInput, PropertyRow, PropertyTable, Slider, Toggle } from '../../../components/ui'
import { ParticlesIcon } from '../sectionIcons'
import { useEventBus } from '../../EventBusContext'
import { vec3ToHex } from '../../../utils/UtilFunctions'
import ParticleSystemSlot from './ParticleSystemSlot'

// The Particle System node inspector: how THIS instance plays an effect. What the effect is — its
// emitters and modules — belongs to the .vfx asset and is edited in the particle editor, reachable
// through the slot above.
//
// Same write-then-read-back pattern as SoundEditor: the node's setters clamp.

export default function ParticleSystemEditor(props: { node: ParticleSystemNode }) {
  const eventEmitter = useEventBus()

  const read = () => ({
    playOnStart: props.node.playOnStart,
    simulationSpeed: props.node.simulationSpeed,
    spawnRateScale: props.node.spawnRateScale,
    tint: [...props.node.tint] as [number, number, number, number],
  })
  const [values, setValues] = useState(read)
  useEffect(() => { setValues(read()) }, [props.node])

  const set = (patch: Partial<ReturnType<typeof read>>) => {
    const n = props.node
    if (patch.playOnStart !== undefined) n.playOnStart = patch.playOnStart
    if (patch.simulationSpeed !== undefined) n.simulationSpeed = patch.simulationSpeed
    if (patch.spawnRateScale !== undefined) n.spawnRateScale = patch.spawnRateScale
    if (patch.tint !== undefined) n.tint = patch.tint
    setValues(read())
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  }

  // Play state lives on the node, which React cannot observe.
  const [, force] = useState(0)
  const transport = (fn: () => void) => { fn(); force(x => x + 1) }
  const [burst, setBurst] = useState(25)

  const emitters = props.node.system.emitters

  return (
    <Collapsable title='Particle System' icon={<ParticlesIcon />} persistKey='particleSystemEditor'>
      <div className='p-2 flex flex-col gap-2'>
        <ParticleSystemSlot node={props.node} onChange={() => force(x => x + 1)} />

        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Play on start' hint='Start emitting as soon as the scene starts.' divider>
            <Toggle checked={values.playOnStart} onChange={playOnStart => set({ playOnStart })} />
          </PropertyRow>
          <PropertyRow label='Simulation speed' hint='Multiplies simulation time: 0.5 is slow motion.' divider>
            <Slider min={0} max={3} step={0.05} value={values.simulationSpeed} onChange={simulationSpeed => set({ simulationSpeed })} />
          </PropertyRow>
          <PropertyRow label='Spawn rate' hint="Multiplies every emitter's continuous spawn rate. Bursts are not scaled." divider>
            <Slider min={0} max={4} step={0.05} value={values.spawnRateScale} onChange={spawnRateScale => set({ spawnRateScale })} />
          </PropertyRow>
          <PropertyRow label='Tint' hint="Multiplies every particle's colour, alpha included.">
            <div className='flex items-center gap-2'>
              <ColorInput color={vec3ToHex(values.tint.slice(0, 3) as [number, number, number])}
                          onChange={c => set({ tint: [c[0], c[1], c[2], values.tint[3]] })} />
              <Slider min={0} max={1} step={0.01} value={values.tint[3]} readout
                      onChange={a => set({ tint: [values.tint[0], values.tint[1], values.tint[2], a] })} />
            </div>
          </PropertyRow>
        </PropertyTable>

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
        <Hint>
          Particles preview while authoring unless switched off in the viewport's visibility menu. Scripts
          drive the same calls: <code>play()</code>, <code>stop()</code>, <code>burst(n)</code>.
        </Hint>
      </div>
    </Collapsable>
  )
}
