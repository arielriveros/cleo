import { useEffect, useState } from 'react'
import { SoundNode, attenuationAt, DISTANCE_MODELS } from 'cleo'
import type { DistanceModel, LoopMode, SoundMode } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import {
  Button, NumberInput, PropertyRow, PropertyTable, SegmentedControl, Select, Slider, Toggle, Hint,
} from '../../../components/ui'
import { SoundIcon, FalloffIcon } from '../sectionIcons'
import { useEventBus } from '../../EventBusContext'
import SoundSampleSlot from './SoundSampleSlot'

// The Sound node inspector: what this EMITTER does, never what the sample sounds like. Volume here is a
// multiplier over the sample's own; loop points, effects and the bus live in the sample editor, reachable
// through the pencil on the slot.
//
// Follows LightEditor's write-then-read-back pattern: every setter on the node clamps, so the UI reads the
// value back rather than trusting what it wrote.

const MODES: { value: SoundMode; label: string; title: string }[] = [
  { value: 'spatial', label: 'Spatial', title: 'Placed in the world and attenuated by distance from the listener' },
  { value: 'ambient', label: 'Ambient', title: 'Heard at a constant level wherever the listener is' },
]

const LOOP_MODES: { value: LoopMode; label: string; title: string }[] = [
  { value: 'inherit', label: 'Sample', title: "Follow the sample's own loop setting" },
  { value: 'on', label: 'On', title: 'Loop regardless of what the sample says' },
  { value: 'off', label: 'Off', title: 'Play once regardless of what the sample says' },
]

const MODEL_LABELS: Record<DistanceModel, string> = {
  inverse: 'Inverse',
  linear: 'Linear',
  exponential: 'Exponential',
}

export default function SoundEditor(props: { node: SoundNode }) {
  const eventEmitter = useEventBus()

  const read = () => ({
    mode: props.node.mode,
    volume: props.node.volume,
    loopMode: props.node.loopMode,
    playOnStart: props.node.playOnStart,
    distanceModel: props.node.distanceModel,
    refDistance: props.node.refDistance,
    maxDistance: props.node.maxDistance,
    rolloffFactor: props.node.rolloffFactor,
  })

  const [values, setValues] = useState(read)
  // Re-read when the selection changes, and force a repaint so the transport button tracks the node.
  useEffect(() => { setValues(read()) }, [props.node])

  /** Write one property through to the node, then re-read: every setter clamps, so the UI must follow. */
  const set = (patch: Partial<ReturnType<typeof read>>) => {
    const n = props.node
    if (patch.mode !== undefined) n.mode = patch.mode
    if (patch.volume !== undefined) n.volume = patch.volume
    if (patch.loopMode !== undefined) n.loopMode = patch.loopMode
    if (patch.playOnStart !== undefined) n.playOnStart = patch.playOnStart
    if (patch.distanceModel !== undefined) n.distanceModel = patch.distanceModel
    if (patch.refDistance !== undefined) n.refDistance = patch.refDistance
    if (patch.maxDistance !== undefined) n.maxDistance = patch.maxDistance
    if (patch.rolloffFactor !== undefined) n.rolloffFactor = patch.rolloffFactor
    setValues(read())
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  }

  // Force a render after play/stop so the buttons reflect the node, which React cannot observe.
  const [, force] = useState(0)
  const transport = (fn: () => void) => { fn(); force(x => x + 1) }

  return (
    <>
      <Collapsable title='Sound' icon={<SoundIcon />} persistKey='soundEditor'>
        <div className='p-2 flex flex-col gap-2'>
          <SoundSampleSlot node={props.node} onChange={() => force(x => x + 1)} />

          <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Mode' hint='Spatial emitters are placed and attenuated; ambient ones are not.' divider>
              <SegmentedControl
                value={values.mode}
                onChange={mode => set({ mode })}
                options={MODES}
                size='sm'
                grow
              />
            </PropertyRow>
            <PropertyRow label='Volume' hint="Multiplied by the sample's own volume." divider>
              <Slider min={0} max={1} step={0.01} value={values.volume} onChange={volume => set({ volume })} />
            </PropertyRow>
            <PropertyRow label='Loop' hint="Overrides the sample's loop setting for this emitter only." divider>
              <SegmentedControl
                value={values.loopMode}
                onChange={loopMode => set({ loopMode })}
                options={LOOP_MODES}
                size='sm'
                grow
              />
            </PropertyRow>
            <PropertyRow label='Play on start' hint='Start automatically when the scene begins playing.'>
              <Toggle checked={values.playOnStart} onChange={playOnStart => set({ playOnStart })} />
            </PropertyRow>
          </PropertyTable>

          <div className='flex items-center gap-1'>
            <Button size='sm' variant='subtle' onClick={() => transport(() => props.node.play())} title='Audition this emitter'>▶ Play</Button>
            <Button size='sm' variant='subtle' onClick={() => transport(() => props.node.stop())} title='Stop'>■ Stop</Button>
            <Hint>
              {props.node.isPlaying ? 'Playing' : 'Stopped'}
            </Hint>
          </div>
          <Hint>
            Sounds are silent while authoring; press Play in the toolbar to hear the scene, or audition one
            emitter with the button above.
          </Hint>
        </div>
      </Collapsable>

      {values.mode === 'spatial' && (
        <Collapsable title='Falloff' icon={<FalloffIcon />} persistKey='soundFalloff'>
          <div className='p-2 flex flex-col gap-2'>
            <PropertyTable columns={['45%', '55%']}>
              <PropertyRow label='Distance model' hint='How volume drops with distance.' divider>
                <Select
                  value={values.distanceModel}
                  onChange={e => set({ distanceModel: e.target.value as DistanceModel })}
                >
                  {DISTANCE_MODELS.map(m => <option key={m} value={m}>{MODEL_LABELS[m]}</option>)}
                </Select>
              </PropertyRow>
              <PropertyRow label='Reference' hint='Full volume within this radius. It gets no louder.' divider>
                <NumberInput value={values.refDistance} min={0.01} step={0.1} onChange={refDistance => set({ refDistance })} />
              </PropertyRow>
              <PropertyRow label='Max' hint='Linear silences here; the other models only clamp at it.' divider>
                <NumberInput value={values.maxDistance} min={0.02} step={1} onChange={maxDistance => set({ maxDistance })} />
              </PropertyRow>
              <PropertyRow label='Rolloff' hint='How steeply it falls off. 0 is no attenuation at all.'>
                <Slider min={0} max={10} step={0.1} value={values.rolloffFactor} onChange={rolloffFactor => set({ rolloffFactor })} />
              </PropertyRow>
            </PropertyTable>

            <FalloffCurve
              model={values.distanceModel}
              refDistance={values.refDistance}
              maxDistance={values.maxDistance}
              rolloff={values.rolloffFactor}
            />
          </div>
        </Collapsable>
      )}
    </>
  )
}

/**
 * The attenuation curve, from the emitter out to `maxDistance`.
 *
 * Drawn from `attenuationAt` — the same function the engine's gizmo uses and the same formulae the Web
 * Audio panner implements — so what is plotted is what will be heard. Four numbers describing a falloff
 * are hard to picture; the shape is not.
 */
function FalloffCurve(props: { model: DistanceModel; refDistance: number; maxDistance: number; rolloff: number }) {
  const { model, refDistance, maxDistance, rolloff } = props
  const width = 200
  const height = 46
  const samples = 64

  const points: string[] = []
  for (let i = 0; i <= samples; i++) {
    const d = (i / samples) * maxDistance
    const gain = attenuationAt(d, model, refDistance, maxDistance, rolloff)
    points.push(`${(i / samples) * width},${height - gain * (height - 2) - 1}`)
  }

  const refX = Math.min(width, (refDistance / maxDistance) * width)

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className='w-full h-[46px]' preserveAspectRatio='none'>
        <rect x={0} y={0} width={width} height={height} fill='rgb(255 255 255 / 0.03)' />
        <line x1={refX} y1={0} x2={refX} y2={height} stroke='rgb(255 210 122 / 0.5)' strokeWidth={1} strokeDasharray='2 2' />
        <polyline points={points.join(' ')} fill='none' stroke='#7fb2d9' strokeWidth={1.5} />
      </svg>
      <Hint>
        Full volume to {refDistance.toFixed(2)}, then falling to {(attenuationAt(maxDistance, model, refDistance, maxDistance, rolloff) * 100).toFixed(0)}% at {maxDistance.toFixed(1)}.
      </Hint>
    </div>
  )
}
