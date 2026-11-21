import { useEffect, useState } from 'react'
import { VOLUMETRIC_FOG_PRESETS, VolumetricFogNode, type VolumetricFogPreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Hint, PresetMenu } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../../EngineContext'
import { VolumetricFogIcon } from '../sectionIcons'
import DeclaredSections from '../../properties/DeclaredSections'

// The Volumetric Fog inspector: a box of medium the sun, the torches and the sky light scatter into, sized
// with the viewport's face handles or the Size row, with fog looks in the preset menu. Its rows are the
// node's declared properties (src/properties/environment.ts).

export default function VolumetricFogEditor(props: { node: VolumetricFogNode }) {
  const { eventEmitter, instance } = useCleoEngine()
  const renderer = instance?.renderer
  const applyPreset = (p: VolumetricFogPreset) => {
    props.node.applyPreset(p)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
  }

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

  return (
    <Collapsable title='Volumetric Fog' icon={<VolumetricFogIcon />} persistKey='volumetricFogEditor'
      right={<PresetMenu presets={VOLUMETRIC_FOG_PRESETS} onApply={applyPreset} title='Fog looks — the medium, not the box' />}>
      <div className='w-full p-2 flex flex-col gap-2'>
        {status && <Hint>{status}</Hint>}
        <DeclaredSections node={props.node} />
      </div>
    </Collapsable>
  )
}
