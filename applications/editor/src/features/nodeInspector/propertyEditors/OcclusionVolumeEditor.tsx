import { useEffect, useState } from 'react'
import { OcclusionVolumeNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Hint } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../../EngineContext'
import { OcclusionVolumeIcon } from '../sectionIcons'
import { DeclaredSection, useNodeTick } from '../../properties/DeclaredSections'

// The Occlusion Volume inspector. What lies wholly inside the box is not rendered while the camera cannot
// see the box (graphics/occlusion/occlusionVolumes.ts); the Occlude rows pick which kinds of content. The rows
// are the node's declared properties (src/properties/environment.ts); the line between them is what the
// renderer made of the box last frame.

export default function OcclusionVolumeEditor(props: { node: OcclusionVolumeNode }) {
  const { instance } = useCleoEngine()
  const renderer = instance?.renderer
  useNodeTick(props.node)   // the line follows Enabled

  // What the renderer made of it last frame: polled, since the camera moves without telling anyone.
  const [status, setStatus] = useState<{ inside: number, hidden: boolean } | null>(null)
  const [mode, setMode] = useState(renderer?.occlusionCulling ?? 'all')
  useEffect(() => {
    if (!renderer) return
    const poll = () => {
      setStatus(renderer.occlusionVolumeStatus(props.node))
      setMode(renderer.occlusionCulling)
    }
    poll()
    const id = window.setInterval(poll, 250)
    return () => window.clearInterval(id)
  }, [renderer, props.node])

  const plural = (n: number) => `${n} node${n === 1 ? '' : 's'}`
  const hint = mode !== 'all'
    ? 'Not acting: Renderer settings › Optimizations › Occlusion is not at + Volumes.'
    : !props.node.enabled ? 'Disabled: hides nothing.'
    : !status ? 'Not acting in this view.'
    : status.inside === 0 ? 'Nothing lies wholly inside the box.'
    : status.hidden ? `Out of sight: skipping ${plural(status.inside)} inside.`
    : `In sight: ${plural(status.inside)} inside, drawn as usual.`

  return (
    <Collapsable title='Occlusion Volume' icon={<OcclusionVolumeIcon />} persistKey='occlusionVolumeEditor'>
      <div className='w-full p-2 flex flex-col gap-2'>
        <DeclaredSection node={props.node} title='' />
        <Hint>{hint}</Hint>
        <DeclaredSection node={props.node} title='Occlude' />
      </div>
    </Collapsable>
  )
}
