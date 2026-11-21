import { useEffect, useState } from 'react'
import { SoundNode, SOUND_FALLOFF_PRESETS, applyPreset, attenuationAt, DISTANCE_MODELS } from 'cleo'
import type { DistanceModel, LoopMode, SoundFalloffPreset, SoundMode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import {
  Button, DocScope, NumberInput, PresetMenu, PropertyRow, PropertyTable, SegmentedControl, Select, Slider, Toggle, Hint,
} from '@cleo/app-kit/ui'
import { SoundIcon, FalloffIcon } from '../sectionIcons'
import { useEventBus } from '../../EventBusContext'
import { DeclaredSection, useNodeTick } from '../../properties/DeclaredSections'
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

  useNodeTick(props.node)
  const values = props.node

  const applyFalloffPreset = (p: SoundFalloffPreset) => {
    applyPreset(props.node, SOUND_FALLOFF_PRESETS, p)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  }

  // Force a render after play/stop so the buttons reflect the node, which React cannot observe.
  const [, force] = useState(0)
  const transport = (fn: () => void) => { fn(); force(x => x + 1) }

  // Documented in Audio › Sound nodes, whose rows are these fields' tooltips (so they carry no hints here).
  return (
    <DocScope page='editor/audio' section='sound-nodes'>
      <Collapsable title='Sound' doc='editor/audio#sound-nodes' icon={<SoundIcon />} persistKey='soundEditor'>
        <div className='p-2 flex flex-col gap-2'>
          <SoundSampleSlot node={props.node} onChange={() => force(x => x + 1)} />

          <DeclaredSection node={props.node} title='' />

          <div className='flex items-center gap-1'>
            <Button size='sm' variant='subtle' onClick={() => transport(() => props.node.play())} title='Audition this emitter'>▶ Play</Button>
            <Button size='sm' variant='subtle' onClick={() => transport(() => props.node.stop())} title='Stop'>■ Stop</Button>
            <Hint>
              {props.node.isPlaying ? 'Playing' : 'Stopped'}
            </Hint>
          </div>
        </div>
      </Collapsable>

      {values.mode === 'spatial' && (
        <Collapsable title='Falloff' icon={<FalloffIcon />} persistKey='soundFalloff'
          right={<PresetMenu presets={SOUND_FALLOFF_PRESETS} onApply={applyFalloffPreset} title='Falloff presets' />}>
          <div className='p-2 flex flex-col gap-2'>
            <DeclaredSection node={props.node} title='Falloff' bare />

            <FalloffCurve
              model={values.distanceModel}
              refDistance={values.refDistance}
              maxDistance={values.maxDistance}
              rolloff={values.rolloffFactor}
            />
          </div>
        </Collapsable>
      )}
    </DocScope>
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
        <rect x={0} y={0} width={width} height={height} className='fill-fg/[0.03]' />
        <line x1={refX} y1={0} x2={refX} y2={height} className='stroke-warning/50' strokeWidth={1} strokeDasharray='2 2' />
        <polyline points={points.join(' ')} fill='none' className='stroke-highlight' strokeWidth={1.5} />
      </svg>
      <Hint>
        Full volume to {refDistance.toFixed(2)}, then falling to {(attenuationAt(maxDistance, model, refDistance, maxDistance, rolloff) * 100).toFixed(0)}% at {maxDistance.toFixed(1)}.
      </Hint>
    </div>
  )
}
