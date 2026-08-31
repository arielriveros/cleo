import { useEffect, useState } from 'react'
import { SkyLightNode } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import { ColorInput } from './LightEditor'
import { vec3ToHex } from '../../../utils/UtilFunctions'
import { useEventBus } from '../../EventBusContext'
import { useCleoEngine } from '../../EngineContext'
import { PropertyTable, PropertyRow, Slider } from '../../../components/ui'
import { SkyIcon } from '../sectionIcons'

type Vec3 = [number, number, number]

const SKY_LIGHT_HINT = 'Lights the scene with the sky itself — a surface facing up receives the zenith, one facing a sunset receives the sunset. Works from the Sky Atmosphere or from a Skybox, whichever the scene has. Add one and there is no need for a light probe just to get ambient light.'
const CLOUD_RESPONSE_HINT = 'How much the scene’s clouds change the lighting. At 1 an overcast sky takes the sun’s strength and its warm cast and hands both to the sky, which also goes flat — so the scene reads white and shadowless. At 0 the clouds are drawn but light nothing.'

/**
 * The sky light has only two authored values; everything else is derived from the sky itself. The L0
 * read-out separates "the projection has not landed" — a failed async readback leaves flat ambient alone —
 * from "the sky is dim".
 */
export default function SkyLightEditor(props: { node: SkyLightNode }) {
  const eventEmitter = useEventBus()
  const { instance } = useCleoEngine()

  const [intensity, setIntensity] = useState(props.node.intensity)
  const [tint, setTint] = useState<Vec3>(props.node.tint)
  const [cloudResponse, setCloudResponse] = useState(props.node.cloudResponse)

  useEffect(() => {
    setIntensity(props.node.intensity)
    setTint(props.node.tint)
    setCloudResponse(props.node.cloudResponse)
  }, [props.node])

  const apply = (next: { intensity?: number; tint?: Vec3; cloudResponse?: number }) => {
    if (next.intensity !== undefined) { props.node.intensity = next.intensity; setIntensity(next.intensity) }
    if (next.tint !== undefined) { props.node.tint = next.tint; setTint(next.tint) }
    if (next.cloudResponse !== undefined) {
      props.node.cloudResponse = next.cloudResponse; setCloudResponse(next.cloudResponse)
    }
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
    <Collapsable title='Sky Light' icon={<SkyIcon />} persistKey='skyLight' hint={SKY_LIGHT_HINT}>
      <div className='w-full p-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Intensity'>
            <Slider min={0} max={4} step={0.05} value={intensity} onChange={(v) => apply({ intensity: v })} />
          </PropertyRow>
          <PropertyRow label='Tint'>
            <ColorInput color={vec3ToHex(tint)} onChange={(c) => apply({ tint: c as Vec3 })} />
          </PropertyRow>
          <PropertyRow label='Cloud Response' divider={false} hint={CLOUD_RESPONSE_HINT}>
            <Slider min={0} max={1} step={0.05} value={cloudResponse}
                    onChange={(v) => apply({ cloudResponse: v })} />
          </PropertyRow>
        </PropertyTable>
        <div className='mt-2 text-xs text-muted'>
          {l0
            ? `Sky colour (L0): ${l0.map(c => c.toFixed(2)).join(', ')}`
            : 'Waiting for the first sky projection…'}
        </div>
      </div>
    </Collapsable>
  )
}
