import { useEffect, useState } from 'react'
import { MIN_WEATHER_VOLUME_SIZE, WeatherNode, WEATHER_PRESETS, type WeatherPreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useEventBus } from '../../EventBusContext'
import { useCleoEngine } from '../../EngineContext'
import { Button, Hint, NumberInput, PresetMenu, PropertyTable, PropertyRow, Slider, Toggle, VectorInput } from '@cleo/app-kit/ui'
import { WeatherIcon } from '../../sceneInspector/nodeIcons'
import { BOX_VOLUME_EDITED } from '../../gizmo/BoxVolumeGizmo'
import MaterialPicker, { liveMaterial } from '../../terrainMaterials/MaterialPicker'

type Vec3 = [number, number, number]

const WETNESS_HINT = 'How wet the ground and the plants inside the box are: 0 dry, 1 soaked. The landscape darkens and turns glossy; foliage materials darken, gloss and bow by their Weather settings.'
const PUDDLES_HINT = 'How much of the wet ground\'s low, flat spots holds standing water: 0 none, 1 every hollow. Water pools in the landscape\'s height maps, and in a noise a few metres across where it has none.'
const SNOW_HINT = 'How much snow lies inside the box: 0 none, 1 thick. It settles on flat ground (low ground first) and on what faces up on foliage materials, and weighs plants down.'
const SHELTER_HINT = 'Covered ground and plants stay dry and free of snow: under a roof, an overhang, a cart, anything solid that casts a shadow from straight above. Off: the weather reaches everything in the box.'

/** The Weather inspector: a box of rain or snow, sized with the viewport's face handles, with its snow material. */
export default function WeatherEditor(props: { node: WeatherNode }) {
  const eventEmitter = useEventBus()
  const { instance } = useCleoEngine()
  const renderer = instance?.renderer
  const read = () => {
    const n = props.node
    return {
      size: [...n.size] as Vec3, bounded: n.bounded, blendDistance: n.blendDistance, priority: n.priority, enabled: n.enabled,
      wetness: n.wetness, snow: n.snow, puddles: n.puddles, snowMaterialId: n.snowMaterialId, hasSnowMaterial: !!n.snowMaterial,
      snowTiling: n.snowTiling, snowSlope: n.snowSlope, snowBreakup: n.snowBreakup, shelter: n.shelter,
    }
  }
  const [f, setF] = useState(read)
  useEffect(() => setF(read()), [props.node])

  // The viewport's face handles resize the box (and move the node) behind this panel's back.
  useEffect(() => {
    const onEdited = (e: { nodeId: string }) => { if (e?.nodeId === props.node.id) setF(read()) }
    eventEmitter.on(BOX_VOLUME_EDITED, onEdited)
    return () => { eventEmitter.off(BOX_VOLUME_EDITED, onEdited) }
  }, [eventEmitter, props.node])

  const changed = () => {
    setF(read())
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
  }
  const set = (patch: Partial<Pick<WeatherNode, 'size' | 'blendDistance' | 'priority' | 'enabled' | 'wetness' | 'snow'
    | 'puddles' | 'snowTiling' | 'snowSlope' | 'snowBreakup' | 'shelter'>>) => {
    Object.assign(props.node, patch)
    changed()
  }
  const applyPreset = (p: WeatherPreset) => { props.node.applyPreset(p); changed() }

  // Whether the renderer drew it last frame: polled, since the camera moves on its own.
  const [status, setStatus] = useState<string | null>(null)
  useEffect(() => {
    if (!renderer) return
    const poll = () => {
      const n = props.node
      if (!n.enabled) { setStatus('Not drawn: disabled.'); return }
      if (!(n.wetness > 0) && !(n.snow > 0)) { setStatus('Dry: raise Wetness or Snow (or pick a preset).'); return }
      const drawn = renderer.weatherFrameVolumes.includes(n)
      setStatus(drawn ? null : 'Not drawn this frame: too far from the camera, or over the volume cap (4 at once; priority decides).')
    }
    poll()
    const id = window.setInterval(poll, 500)
    return () => window.clearInterval(id)
  }, [renderer, props.node])

  const makeBounded = () => { set({ size: [40, 20, 40] }) }

  return (
    <Collapsable title='Weather' icon={<WeatherIcon />} persistKey='weather'
      right={<PresetMenu presets={WEATHER_PRESETS} onApply={applyPreset} title='Weather presets — how wet, the puddles, how much snow' />}>
      <div className='w-full p-2 flex flex-col gap-2'>
        {status && <Hint>{status}</Hint>}
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Enabled' divider>
            <Toggle checked={f.enabled} onChange={enabled => set({ enabled })} />
          </PropertyRow>
          {f.bounded ? <>
            <PropertyRow label='Size' hint='The box, in local units, centred on the node. Drag its faces in the viewport. The weather falls only inside it.'>
              <VectorInput value={f.size} min={MIN_WEATHER_VOLUME_SIZE} step={0.5} onChange={size => set({ size: size as Vec3 })} />
            </PropertyRow>
            <PropertyRow label='Blend Distance' hint='Metres over which the weather fades in at the faces.'>
              <NumberInput value={f.blendDistance} min={0} step={0.5} onChange={blendDistance => set({ blendDistance })} />
            </PropertyRow>
          </> : <PropertyRow label='Size' hint='Unbounded: this weather covers the whole scene, as every weather node saved before volumes does.'>
            <Button size='sm' onClick={makeBounded} title='Give it a 40 x 20 x 40 m box, sized with the viewport handles'>Make bounded</Button>
          </PropertyRow>}
          <PropertyRow label='Priority' divider hint='Where volumes overlap, the higher draws over the lower (a dry box inside a snowy one carves out a dry pocket); it also decides which draw when more than 4 are near.'>
            <NumberInput value={f.priority} step={1} onChange={priority => set({ priority })} />
          </PropertyRow>
          <PropertyRow label='Wetness' hint={WETNESS_HINT}>
            <Slider min={0} max={1} step={0.01} value={f.wetness} readout onChange={wetness => set({ wetness })} />
          </PropertyRow>
          <PropertyRow label='Puddles' divider hint={PUDDLES_HINT}>
            <Slider min={0} max={1} step={0.01} value={f.puddles} readout onChange={puddles => set({ puddles })} />
          </PropertyRow>
          <PropertyRow label='Snow' hint={SNOW_HINT}>
            <Slider min={0} max={1} step={0.01} value={f.snow} readout onChange={snow => set({ snow })} />
          </PropertyRow>
          <PropertyRow label='Snow Material' hint='What the landscape draws its snow with: a PBR material (its colour, normal and roughness maps). Plants take its colour and roughness. None: flat white snow.'>
            <div className='flex items-start gap-1'>
              <div className='flex-1 min-w-0'>
                <MaterialPicker value={f.snowMaterialId} placeholder={f.hasSnowMaterial ? '(unlinked material)' : '(flat snow)'}
                  newName={() => 'Snow'} title='The material snow is drawn with — drop one here too'
                  onPick={a => { props.node.snowMaterial = liveMaterial(a); props.node.snowMaterialId = a.id; changed() }} />
              </div>
              {f.hasSnowMaterial && <Button variant='remove' size='sm' title='Flat white snow instead'
                onClick={() => { props.node.snowMaterial = null; props.node.snowMaterialId = null; changed() }}>✕</Button>}
            </div>
          </PropertyRow>
          <PropertyRow label='Snow Tiling' hint='Metres per repeat of the snow material on the landscape.'>
            <NumberInput value={f.snowTiling} min={0.05} step={0.5} onChange={snowTiling => set({ snowTiling })} />
          </PropertyRow>
          <PropertyRow label='Snow Slope' hint='Degrees: ground steeper than this sheds its snow.'>
            <Slider min={0} max={90} step={1} value={f.snowSlope} readout onChange={snowSlope => set({ snowSlope })} />
          </PropertyRow>
          <PropertyRow label='Snow Breakup' divider hint='How much a noise breaks the snow into patches at its edge: 0 a clean line, 1 ragged drifts.'>
            <Slider min={0} max={1} step={0.01} value={f.snowBreakup} readout onChange={snowBreakup => set({ snowBreakup })} />
          </PropertyRow>
          <PropertyRow label='Shelter' divider={false} hint={SHELTER_HINT}>
            <Toggle checked={f.shelter} onChange={shelter => set({ shelter })} />
          </PropertyRow>
        </PropertyTable>
        {f.shelter && renderer && !renderer.weatherShelterEnabled &&
          <Hint>Shelter is switched off in the Renderer settings (Weather) or by the quality tier: the weather reaches everything in the box.</Hint>}
      </div>
    </Collapsable>
  )
}
