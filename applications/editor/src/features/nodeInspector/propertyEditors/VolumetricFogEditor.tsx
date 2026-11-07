import { useEffect, useState } from 'react'
import { MIN_FOG_VOLUME_SIZE, VOLUMETRIC_FOG_PRESETS, VolumetricFogNode, type VolumetricFogPreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { ColorInput, Hint, NumberInput, PresetMenu, PropertyRow, PropertyTable, Slider, Toggle, VectorInput } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../../EngineContext'
import { VolumetricFogIcon } from '../sectionIcons'
import { BOX_VOLUME_EDITED } from '../../gizmo/BoxVolumeGizmo'
import { vec3ToHex } from '../../../utils/UtilFunctions'

type Vec3 = [number, number, number]

// The Volumetric Fog inspector: a box of medium the sun, the torches and the sky light scatter into, sized
// with the viewport's face handles or the Size row, with fog looks in the preset menu.

export default function VolumetricFogEditor(props: { node: VolumetricFogNode }) {
  const { eventEmitter, instance } = useCleoEngine()
  const renderer = instance?.renderer
  const read = () => {
    const n = props.node
    return {
      size: [...n.size] as Vec3, blendDistance: n.blendDistance, priority: n.priority, enabled: n.enabled,
      density: n.density, albedo: [...n.albedo] as Vec3, emissiveColor: [...n.emissiveColor] as Vec3,
      emissiveIntensity: n.emissiveIntensity, anisotropy: n.anisotropy, heightFalloff: n.heightFalloff,
      noiseStrength: n.noiseStrength, noiseScale: n.noiseScale, windVelocity: [...n.windVelocity] as Vec3,
      sunScattering: n.sunScattering, localLightScattering: n.localLightScattering, ambientScattering: n.ambientScattering,
    }
  }
  const [v, setV] = useState(read)
  useEffect(() => { setV(read()) }, [props.node])

  // The viewport's face handles resize the box (and move the node) behind this panel's back.
  useEffect(() => {
    const onEdited = (e: { nodeId: string }) => { if (e?.nodeId === props.node.id) setV(read()) }
    eventEmitter.on(BOX_VOLUME_EDITED, onEdited)
    return () => { eventEmitter.off(BOX_VOLUME_EDITED, onEdited) }
  }, [eventEmitter, props.node])

  const set = (patch: Partial<ReturnType<typeof read>>) => {
    Object.assign(props.node, patch)
    setV(read())
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
  }
  const applyPreset = (p: VolumetricFogPreset) => { props.node.applyPreset(p); setV(read()); eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node }) }

  // Whether the renderer drew it last frame: polled, since the camera and the settings move on their own.
  const [status, setStatus] = useState<string | null>(null)
  useEffect(() => {
    if (!renderer) return
    const poll = () => {
      if (!renderer.volumetricFogEnabled) { setStatus('Not drawn: Volumetric Fog is off in the Renderer settings (or the quality tier).'); return }
      if (!props.node.enabled) { setStatus('Not drawn: disabled.'); return }
      const drawn = renderer.volumetricFogFrameVolumes.includes(props.node)
      setStatus(drawn ? null : 'Not drawn this frame: out of view, past the fog distance, or over the volume cap (16; priority decides).')
    }
    poll()
    const id = window.setInterval(poll, 500)
    return () => window.clearInterval(id)
  }, [renderer, props.node])

  const visibility = v.density > 0 ? `${(3.9 / v.density).toFixed(v.density > 0.39 ? 1 : 0)} m` : 'clear'

  return (
    <Collapsable title='Volumetric Fog' icon={<VolumetricFogIcon />} persistKey='volumetricFogEditor'
      right={<PresetMenu presets={VOLUMETRIC_FOG_PRESETS} onApply={applyPreset} title='Fog looks — the medium, not the box' />}>
      <div className='w-full p-2 flex flex-col gap-2'>
        {status && <Hint>{status}</Hint>}
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Enabled' divider>
            <Toggle checked={v.enabled} onChange={enabled => set({ enabled })} />
          </PropertyRow>
          <PropertyRow label='Size' hint='The box, in local units, centred on the node. Drag its faces in the viewport.'>
            <VectorInput value={v.size} min={MIN_FOG_VOLUME_SIZE} step={0.5} onChange={size => set({ size: size as Vec3 })} />
          </PropertyRow>
          <PropertyRow label='Blend Distance' hint='Metres over which the fog fades in at the faces.'>
            <NumberInput value={v.blendDistance} min={0} step={0.5} onChange={blendDistance => set({ blendDistance })} />
          </PropertyRow>
          <PropertyRow label='Priority' divider hint='Which volumes are drawn first when more are in view than the renderer draws (16). Overlapping volumes add up.'>
            <NumberInput value={v.priority} step={1} onChange={priority => set({ priority })} />
          </PropertyRow>
          <PropertyRow label='Density' hint={`Extinction per metre: how fast the fog hides what is behind it. Visibility about ${visibility}.`}>
            <NumberInput value={v.density} min={0} step={0.005} onChange={density => set({ density })} />
          </PropertyRow>
          <PropertyRow label='Albedo' hint='How much of the light the fog takes it scatters rather than absorbs: near white for mist, darker and warmer for smoke.'>
            <ColorInput color={vec3ToHex(v.albedo)} onChange={c => set({ albedo: [c[0], c[1], c[2]] })} />
          </PropertyRow>
          <PropertyRow label='Anisotropy' hint='0 scatters evenly; toward 1 the fog glows round a light seen through it, as mist does round a lamp.'>
            <Slider min={-0.9} max={0.9} step={0.01} value={v.anisotropy} readout onChange={anisotropy => set({ anisotropy })} />
          </PropertyRow>
          <PropertyRow label='Height Falloff' divider hint='Per metre: the fog thins from the bottom of the box up. 0 is even through the box.'>
            <NumberInput value={v.heightFalloff} min={0} step={0.05} onChange={heightFalloff => set({ heightFalloff })} />
          </PropertyRow>
          <PropertyRow label='Noise' hint='How much a drifting noise breaks the fog into wisps.'>
            <Slider min={0} max={1} step={0.01} value={v.noiseStrength} readout onChange={noiseStrength => set({ noiseStrength })} />
          </PropertyRow>
          <PropertyRow label='Noise Scale' hint='Metres per wisp.'>
            <NumberInput value={v.noiseScale} min={0.05} step={0.5} onChange={noiseScale => set({ noiseScale })} />
          </PropertyRow>
          <PropertyRow label='Wind' divider hint='World metres per second the wisps drift.'>
            <VectorInput value={v.windVelocity} step={0.1} onChange={w => set({ windVelocity: w as Vec3 })} />
          </PropertyRow>
          <PropertyRow label='Emissive Color' hint='Light the fog gives off itself: a glowing haze, smoke over a fire.'>
            <ColorInput color={vec3ToHex(v.emissiveColor)} onChange={c => set({ emissiveColor: [c[0], c[1], c[2]] })} />
          </PropertyRow>
          <PropertyRow label='Emissive (nits)' divider hint='How bright that glow is, in cd/m² per metre of fog.'>
            <NumberInput value={v.emissiveIntensity} min={0} step={1} onChange={emissiveIntensity => set({ emissiveIntensity })} />
          </PropertyRow>
          <PropertyRow label='Sun Scattering' hint='Multiplier on the sun or moon light the fog scatters (its shafts).'>
            <NumberInput value={v.sunScattering} min={0} step={0.1} onChange={sunScattering => set({ sunScattering })} />
          </PropertyRow>
          <PropertyRow label='Light Scattering' hint='Multiplier on the point and spot lights it scatters (the halos round torches).'>
            <NumberInput value={v.localLightScattering} min={0} step={0.1} onChange={localLightScattering => set({ localLightScattering })} />
          </PropertyRow>
          <PropertyRow label='Ambient Scattering' hint="Multiplier on the sky's fill it scatters.">
            <NumberInput value={v.ambientScattering} min={0} step={0.1} onChange={ambientScattering => set({ ambientScattering })} />
          </PropertyRow>
        </PropertyTable>
      </div>
    </Collapsable>
  )
}
