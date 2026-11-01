import { useEffect, useState } from 'react'
import { WeatherNode, WEATHER_PRESETS, type WeatherPreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useEventBus } from '../../EventBusContext'
import { PresetMenu, PropertyTable, PropertyRow, Slider } from '@cleo/app-kit/ui'
import { WeatherIcon } from '../../sceneInspector/nodeIcons'

const WETNESS_HINT = 'How wet everything is: 0 dry, 1 soaked. Foliage materials darken, turn glossy and bow by their Weather settings.'
const SNOW_HINT = 'How much snow lies on things: 0 none, 1 thick. It settles on what faces up on foliage materials, and weighs them down.'

type Fields = { wetness: number; snow: number }
const read = (n: WeatherNode): Fields => ({ wetness: n.wetness, snow: n.snow })

export default function WeatherEditor(props: { node: WeatherNode }) {
  const eventEmitter = useEventBus()
  const [f, setF] = useState<Fields>(() => read(props.node))
  useEffect(() => setF(read(props.node)), [props.node])

  const apply = (patch: Partial<Fields>) => {
    const n = props.node
    if (patch.wetness !== undefined) n.wetness = patch.wetness
    if (patch.snow !== undefined) n.snow = patch.snow
    setF(read(n))
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: n })
  }

  const applyPreset = (p: WeatherPreset) => {
    props.node.applyPreset(p)
    setF(read(props.node))
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
  }

  return (
    <Collapsable title='Weather' icon={<WeatherIcon />} persistKey='weather'
      right={<PresetMenu presets={WEATHER_PRESETS} onApply={applyPreset} title='Weather presets — how wet, how much snow' />}>
      <div className='w-full p-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Wetness' hint={WETNESS_HINT}>
            <Slider min={0} max={1} step={0.01} value={f.wetness} onChange={v => apply({ wetness: v })} />
          </PropertyRow>
          <PropertyRow label='Snow' divider={false} hint={SNOW_HINT}>
            <Slider min={0} max={1} step={0.01} value={f.snow} onChange={v => apply({ snow: v })} />
          </PropertyRow>
        </PropertyTable>
      </div>
    </Collapsable>
  )
}
