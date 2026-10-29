import { useEffect, useState } from 'react'
import { WindNode, WIND_PRESETS, type WindPreset } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import { useEventBus } from '../../EventBusContext'
import { PresetMenu, PropertyTable, PropertyRow, Slider } from '../../../components/ui'
import { WindIcon } from '../../sceneInspector/nodeIcons'

const DIRECTION_HINT = 'The way the wind blows, in degrees around the up axis (0 = +X, 90 = −Z).'
const STRENGTH_HINT = 'Scales every plant’s lean at once: 0 is calm, 1 is what the materials were authored for, 2 is a storm.'
const GUST_SCALE_HINT = 'Metres between gust crests. Small values make plants next to each other move differently; large values make whole fields lean together.'
const GUST_SPEED_HINT = 'How fast gusts roll across the ground, in metres per second.'
const FADE_HINT = 'Plants further than this from the camera stop moving (fading out from Fade start). Distant foliage then uses the cheaper still shaders, which is where most of the performance comes from.'

type Fields = { direction: number; strength: number; gustScale: number; gustSpeed: number; fadeStart: number; fadeEnd: number }

const read = (n: WindNode): Fields => ({
  direction: n.direction, strength: n.strength, gustScale: n.gustScale,
  gustSpeed: n.gustSpeed, fadeStart: n.fadeStart, fadeEnd: n.fadeEnd,
})

export default function WindEditor(props: { node: WindNode }) {
  const eventEmitter = useEventBus()
  const [f, setF] = useState<Fields>(() => read(props.node))
  useEffect(() => setF(read(props.node)), [props.node])

  const apply = (patch: Partial<Fields>) => {
    const n = props.node
    if (patch.direction !== undefined) n.direction = patch.direction
    if (patch.strength !== undefined) n.strength = patch.strength
    if (patch.gustScale !== undefined) n.gustScale = patch.gustScale
    if (patch.gustSpeed !== undefined) n.gustSpeed = patch.gustSpeed
    if (patch.fadeStart !== undefined) n.fadeStart = patch.fadeStart
    if (patch.fadeEnd !== undefined) n.fadeEnd = patch.fadeEnd
    setF(read(n))   // the node clamps (fade end stays past fade start), so read back what it kept
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: n })
  }

  const applyPreset = (p: WindPreset) => {
    props.node.applyPreset(p)
    setF(read(props.node))
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
  }

  return (
    <Collapsable title='Wind' icon={<WindIcon />} persistKey='wind'
      right={<PresetMenu presets={WIND_PRESETS} onApply={applyPreset} title='Wind presets — strength and gusts; the direction stays yours' />}>
      <div className='w-full p-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Direction' hint={DIRECTION_HINT}>
            <Slider min={0} max={360} step={1} value={f.direction} onChange={v => apply({ direction: v })} />
          </PropertyRow>
          <PropertyRow label='Strength' hint={STRENGTH_HINT}>
            <Slider min={0} max={2} step={0.05} value={f.strength} onChange={v => apply({ strength: v })} />
          </PropertyRow>
          <PropertyRow label='Gust size' hint={GUST_SCALE_HINT}>
            <Slider min={2} max={80} step={1} value={f.gustScale} onChange={v => apply({ gustScale: v })} />
          </PropertyRow>
          <PropertyRow label='Gust speed' hint={GUST_SPEED_HINT}>
            <Slider min={0} max={20} step={0.5} value={f.gustSpeed} onChange={v => apply({ gustSpeed: v })} />
          </PropertyRow>
          <PropertyRow label='Fade start' hint={FADE_HINT}>
            <Slider min={5} max={200} step={1} value={f.fadeStart} onChange={v => apply({ fadeStart: v })} />
          </PropertyRow>
          <PropertyRow label='Fade end' divider={false} hint={FADE_HINT}>
            <Slider min={6} max={250} step={1} value={f.fadeEnd} onChange={v => apply({ fadeEnd: v })} />
          </PropertyRow>
        </PropertyTable>
      </div>
    </Collapsable>
  )
}
