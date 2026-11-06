import { useEffect, useState } from 'react'
import { OCCLUSION_VOLUME_CULL_KEYS, OcclusionVolumeNode, type OcclusionVolumeCull } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { DocHover, Hint, PropertyRow, PropertyTable, SectionTitle, Toggle, VectorInput, useDocEntry } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../../EngineContext'
import { OcclusionVolumeIcon } from '../sectionIcons'
import { BOX_VOLUME_EDITED } from '../../gizmo/BoxVolumeGizmo'

// The Occlusion Volume inspector. What lies wholly inside the box is not rendered while the camera cannot
// see the box (graphics/occlusion/occlusionVolumes.ts); the Occlude checkboxes pick which kinds of content.

const CULL_LABELS: Record<keyof OcclusionVolumeCull, string> = {
  models: 'Models', sprites: 'Sprites', particles: 'Particles', lights: 'Lights',
  decals: 'Decals', fluids: 'Fluids', shadows: 'Shadows',
}

/** One checkbox of the Occlude list, its label hovering its docs row. */
function CullCheckbox(props: { label: string, checked: boolean, onChange: (on: boolean) => void }) {
  const entry = useDocEntry(props.label, undefined, 'field')
  return (
    <label className='flex items-center gap-1.5 text-ui select-none cursor-pointer'>
      <input type='checkbox' className='shrink-0 accent-primary' checked={props.checked}
        onChange={e => props.onChange(e.target.checked)} />
      <DocHover entry={entry} affordance='field'>{props.label}</DocHover>
    </label>
  )
}

export default function OcclusionVolumeEditor(props: { node: OcclusionVolumeNode }) {
  const { eventEmitter, instance } = useCleoEngine()
  const renderer = instance?.renderer
  const read = () => ({ size: [...props.node.size] as [number, number, number], enabled: props.node.enabled, cull: props.node.cull })
  const [v, setV] = useState(read)
  useEffect(() => { setV(read()) }, [props.node])

  // The viewport's face handles resize the box (and move the node) behind this panel's back.
  useEffect(() => {
    const onEdited = (e: { nodeId: string }) => { if (e?.nodeId === props.node.id) setV(read()) }
    eventEmitter.on(BOX_VOLUME_EDITED, onEdited)
    return () => { eventEmitter.off(BOX_VOLUME_EDITED, onEdited) }
  }, [eventEmitter, props.node])

  const changed = () => {
    setV(read())
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  }
  const set = (patch: { size?: [number, number, number], enabled?: boolean }) => {
    if (patch.size !== undefined) props.node.size = patch.size
    if (patch.enabled !== undefined) props.node.enabled = patch.enabled
    changed()
  }
  const setCull = (key: keyof OcclusionVolumeCull, on: boolean) => { props.node.setCull(key, on); changed() }

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
    : !v.enabled ? 'Disabled: hides nothing.'
    : !status ? 'Not acting in this view.'
    : status.inside === 0 ? 'Nothing lies wholly inside the box.'
    : status.hidden ? `Out of sight: skipping ${plural(status.inside)} inside.`
    : `In sight: ${plural(status.inside)} inside, drawn as usual.`

  return (
    <Collapsable title='Occlusion Volume' icon={<OcclusionVolumeIcon />} persistKey='occlusionVolumeEditor'>
      <div className='w-full p-2 flex flex-col gap-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Enabled' divider>
            <Toggle checked={v.enabled} onChange={enabled => set({ enabled })} />
          </PropertyRow>
          <PropertyRow label='Size' divider={false}>
            <VectorInput value={v.size} min={0} step={0.25} onChange={size => set({ size: size as [number, number, number] })} />
          </PropertyRow>
        </PropertyTable>
        <Hint>{hint}</Hint>
        <SectionTitle title='Occlude' />
        <div className='grid grid-cols-2 gap-x-3 gap-y-1.5 px-1'>
          {OCCLUSION_VOLUME_CULL_KEYS.map(key => (
            <CullCheckbox key={key} label={CULL_LABELS[key]} checked={v.cull[key]} onChange={on => setCull(key, on)} />
          ))}
        </div>
      </div>
    </Collapsable>
  )
}
