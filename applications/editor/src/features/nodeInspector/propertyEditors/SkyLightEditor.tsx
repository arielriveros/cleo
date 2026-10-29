import { useEffect, useState } from 'react'
import { SkyLightNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { ColorInput } from './LightEditor'
import { vec3ToHex } from '../../../utils/UtilFunctions'
import { useEventBus } from '../../EventBusContext'
import { useCleoEngine } from '../../EngineContext'
import { PropertyTable, PropertyRow, Slider, Toggle } from '@cleo/app-kit/ui'
import { SkyIcon } from '../sectionIcons'

type Vec3 = [number, number, number]

const CLOUD_SHADOWS_HINT = 'The volumetric clouds shade the ground: the sun is dimmed under each cloud, and the shadows drift with the cloud wind. Shown while the scene has enabled Volumetric Clouds.'
const AMBIENT_HINT = 'Scales the scene’s flat ambient fill (Scene settings → Ambient) while this sky light is in the scene. That fill lights every shadow evenly and, unlike the sky light, does not darken with the sky. At 0 only the sky light and any light probes light the shade.'
const NIGHT_AMBIENT_HINT = 'How much of that ambient fill is kept once the sun is down. It fades with the sky over dusk, so the day keeps its fill. At 0 a night without a moon goes almost pitch black; the moon, torches and the sky light still light it.'
const CLOUD_RESPONSE_HINT = 'How much the scene’s clouds change the lighting. At 1 an overcast sky takes the sun’s strength and its warm cast and hands both to the sky, which also goes flat — so the scene reads white and shadowless. At 0 the clouds are drawn but light nothing.'

/**
 * The sky light has few authored values; everything else is derived from the sky itself. The L0
 * read-out separates "the projection has not landed" — a failed async readback leaves flat ambient alone —
 * from "the sky is dim".
 */
export default function SkyLightEditor(props: { node: SkyLightNode }) {
  const eventEmitter = useEventBus()
  const { instance } = useCleoEngine()

  const [intensity, setIntensity] = useState(props.node.intensity)
  const [tint, setTint] = useState<Vec3>(props.node.tint)
  const [cloudResponse, setCloudResponse] = useState(props.node.cloudResponse)
  const [cloudShadows, setCloudShadows] = useState(props.node.cloudShadows)
  const [cloudShadowStrength, setCloudShadowStrength] = useState(props.node.cloudShadowStrength)
  const [ambient, setAmbient] = useState(props.node.ambient)
  const [nightAmbient, setNightAmbient] = useState(props.node.nightAmbient)

  useEffect(() => {
    setIntensity(props.node.intensity)
    setTint(props.node.tint)
    setCloudResponse(props.node.cloudResponse)
    setCloudShadows(props.node.cloudShadows)
    setCloudShadowStrength(props.node.cloudShadowStrength)
    setAmbient(props.node.ambient)
    setNightAmbient(props.node.nightAmbient)
  }, [props.node])

  // Cloud shadows only mean something while the scene draws volumetric clouds, so the toggle follows them.
  const cloudsPresent = () => {
    const clouds = props.node.scene?.volumetricClouds
    return !!clouds && clouds.enabled
  }
  const [hasClouds, setHasClouds] = useState(cloudsPresent)
  useEffect(() => {
    const refresh = () => setHasClouds(cloudsPresent())
    refresh()
    eventEmitter.on('SCENE_CHANGED', refresh)
    return () => { eventEmitter.off('SCENE_CHANGED', refresh) }
  }, [eventEmitter, props.node])

  const apply = (next: {
    intensity?: number; tint?: Vec3; cloudResponse?: number; cloudShadows?: boolean; cloudShadowStrength?: number
    ambient?: number; nightAmbient?: number
  }) => {
    if (next.cloudShadows !== undefined) { props.node.cloudShadows = next.cloudShadows; setCloudShadows(next.cloudShadows) }
    if (next.cloudShadowStrength !== undefined) {
      props.node.cloudShadowStrength = next.cloudShadowStrength; setCloudShadowStrength(next.cloudShadowStrength)
    }
    if (next.intensity !== undefined) { props.node.intensity = next.intensity; setIntensity(next.intensity) }
    if (next.tint !== undefined) { props.node.tint = next.tint; setTint(next.tint) }
    if (next.cloudResponse !== undefined) {
      props.node.cloudResponse = next.cloudResponse; setCloudResponse(next.cloudResponse)
    }
    if (next.ambient !== undefined) { props.node.ambient = next.ambient; setAmbient(next.ambient) }
    if (next.nightAmbient !== undefined) { props.node.nightAmbient = next.nightAmbient; setNightAmbient(next.nightAmbient) }
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
  }

  // Polled, not pushed: the projection lands on whatever frame its readback resolves on.
  const [l0, setL0] = useState<Vec3 | null>(null)
  useEffect(() => {
    const read = () => {
      const sh = instance?.renderer.skyLightSH
      setL0(sh ? [sh[0], sh[1], sh[2]] : null)
    }
    read()
    const id = window.setInterval(read, 500)
    return () => window.clearInterval(id)
  }, [instance, props.node])

  return (
    <Collapsable title='Sky Light' icon={<SkyIcon />} persistKey='skyLight'>
      <div className='w-full p-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Intensity'>
            <Slider min={0} max={4} step={0.05} value={intensity} onChange={(v) => apply({ intensity: v })} />
          </PropertyRow>
          <PropertyRow label='Tint'>
            <ColorInput color={vec3ToHex(tint)} onChange={(c) => apply({ tint: c as Vec3 })} />
          </PropertyRow>
          <PropertyRow label='Ambient' hint={AMBIENT_HINT}>
            <Slider min={0} max={2} step={0.05} value={ambient} onChange={(v) => apply({ ambient: v })} />
          </PropertyRow>
          <PropertyRow label='Night Ambient' hint={NIGHT_AMBIENT_HINT}>
            <Slider min={0} max={1} step={0.01} value={nightAmbient}
                    onChange={(v) => apply({ nightAmbient: v })} />
          </PropertyRow>
          <PropertyRow label='Cloud Response' divider={hasClouds} hint={CLOUD_RESPONSE_HINT}>
            <Slider min={0} max={1} step={0.05} value={cloudResponse}
                    onChange={(v) => apply({ cloudResponse: v })} />
          </PropertyRow>
          {hasClouds &&
            <PropertyRow label='Cloud Shadows' divider={cloudShadows} hint={CLOUD_SHADOWS_HINT}>
              <Toggle checked={cloudShadows} onChange={(c) => apply({ cloudShadows: c })} />
            </PropertyRow>}
          {hasClouds && cloudShadows &&
            <PropertyRow label='Shadow Strength' divider={false}>
              <Slider min={0} max={1} step={0.05} value={cloudShadowStrength}
                      onChange={(v) => apply({ cloudShadowStrength: v })} />
            </PropertyRow>}
        </PropertyTable>
        <div className='mt-2 text-ui text-muted'>
          {l0
            ? `Sky colour (L0): ${l0.map(c => c.toFixed(2)).join(', ')}`
            : 'Waiting for the first sky projection…'}
        </div>
      </div>
    </Collapsable>
  )
}
