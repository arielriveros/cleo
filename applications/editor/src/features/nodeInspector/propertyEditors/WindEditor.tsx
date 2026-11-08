import { useEffect, useState } from 'react'
import { WindNode, WIND_PRESETS, WIND_REFERENCE_SPEED, type WindPreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useEventBus } from '../../EventBusContext'
import { useDebugVisibility } from '../../DebugVisibilityContext'
import { PresetMenu, PropertyTable, PropertyRow, Slider, Toggle } from '@cleo/app-kit/ui'
import { WindIcon } from '../../sceneInspector/nodeIcons'

const DIRECTION_HINT = 'The way the wind blows, in degrees around the up axis (0 = +X, 90 = −Z).'
const STRENGTH_HINT = `Scales the air and every plant’s lean at once: 0 is calm, 1 is what the materials were authored for (about ${WIND_REFERENCE_SPEED} m/s in a full gust), 2 is a storm.`
const GUST_SCALE_HINT = 'Metres between gust crests. Small values make plants next to each other move differently; large values make whole fields lean together.'
const GUST_SPEED_HINT = 'How fast gusts roll across the ground, in metres per second.'
const GUSTINESS_HINT = 'How much of the air the gusts carry. 0 is a steady stream; 1 is still air between the gusts.'
const VEER_HINT = 'The most the wind turns away from its direction, either way, from one meadow to the next — and as the gusts pass. 0 blows the same way everywhere.'
const FADE_HINT = 'Plants further than this from the camera stop moving (fading out from Fade start). Distant foliage then uses the cheaper still shaders, which is where most of the performance comes from.'
const FIELD_HINT = 'Draw the wind field in the viewport: arrows of the air round the camera, streaks carried by it, and the Force Fields that move it. Selecting this node shows it anyway; this keeps it up when you select something else.'

type Fields = { direction: number; strength: number; gustScale: number; gustSpeed: number; gustiness: number; veer: number; fadeStart: number; fadeEnd: number }

const read = (n: WindNode): Fields => ({
  direction: n.direction, strength: n.strength, gustScale: n.gustScale, gustSpeed: n.gustSpeed,
  gustiness: n.gustiness, veer: n.veer, fadeStart: n.fadeStart, fadeEnd: n.fadeEnd,
})

export default function WindEditor(props: { node: WindNode }) {
  const eventEmitter = useEventBus()
  const { visibility, setCategory } = useDebugVisibility()
  const [f, setF] = useState<Fields>(() => read(props.node))
  useEffect(() => setF(read(props.node)), [props.node])

  const apply = (patch: Partial<Fields>) => {
    const n = props.node
    if (patch.direction !== undefined) n.direction = patch.direction
    if (patch.strength !== undefined) n.strength = patch.strength
    if (patch.gustScale !== undefined) n.gustScale = patch.gustScale
    if (patch.gustSpeed !== undefined) n.gustSpeed = patch.gustSpeed
    if (patch.gustiness !== undefined) n.gustiness = patch.gustiness
    if (patch.veer !== undefined) n.veer = patch.veer
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

  // The air between gusts and at their crest (gustiness takes the lull down from the crest).
  const crest = f.strength * WIND_REFERENCE_SPEED
  const lull = crest * (1 - f.gustiness)
  const air = crest < 0.05 ? 'Still air' : `Air ${lull.toFixed(1)} m/s between gusts, ${crest.toFixed(1)} at their crest`

  return (
    <Collapsable title='Wind' icon={<WindIcon />} persistKey='wind'
      right={<PresetMenu presets={WIND_PRESETS} onApply={applyPreset} title='Wind presets — strength, gusts and veer; the direction stays yours' />}>
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
          <PropertyRow label='Gustiness' hint={GUSTINESS_HINT}>
            <Slider min={0} max={1} step={0.05} value={f.gustiness} onChange={v => apply({ gustiness: v })} />
          </PropertyRow>
          <PropertyRow label='Veer' hint={VEER_HINT}>
            <Slider min={0} max={60} step={1} value={f.veer} onChange={v => apply({ veer: v })} />
          </PropertyRow>
          <PropertyRow label='Fade start' hint={FADE_HINT}>
            <Slider min={5} max={200} step={1} value={f.fadeStart} onChange={v => apply({ fadeStart: v })} />
          </PropertyRow>
          <PropertyRow label='Fade end' hint={FADE_HINT}>
            <Slider min={6} max={250} step={1} value={f.fadeEnd} onChange={v => apply({ fadeEnd: v })} />
          </PropertyRow>
          <PropertyRow label='Show field' divider={false} hint={FIELD_HINT}>
            <Toggle checked={visibility.windField.editor} onChange={on => setCategory('windField', 'editor', on)} />
          </PropertyRow>
        </PropertyTable>
        <p className='text-ui-sm text-muted mt-1'>{air}</p>
      </div>
    </Collapsable>
  )
}
