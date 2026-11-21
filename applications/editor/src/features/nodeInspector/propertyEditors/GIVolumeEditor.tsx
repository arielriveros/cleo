import { useEffect, useState } from 'react'
import { GIVolumeNode, GiBakeRegistry, Logger, newGiBakeId } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Button, Hint } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../../EngineContext'
import { GiVolumeIcon } from '../sectionIcons'
import { saveGiBake } from '../../../utils/giBakeStore'
import DeclaredSections, { useNodeTick } from '../../properties/DeclaredSections'

// The GI Volume inspector. The volume is an oriented box (the node's full transform) filled corner to
// corner with a grid of irradiance probes; the renderer captures what each probe's rays hit and relights
// them as the light changes (render/gi/giSystem.ts). Its rows are the volume's declared properties
// (src/properties/probes.ts); the card adds the capture's progress and the bake controls.

export default function GIVolumeEditor(props: { node: GIVolumeNode }) {
  const { eventEmitter, instance } = useCleoEngine()
  const renderer = instance?.renderer
  useNodeTick(props.node)

  // How far the capture has got: polled, since it runs a batch at a time on render frames.
  const [status, setStatus] = useState<{ probes: number, captured: number, active: number, idle: boolean,
                                         complete: boolean, saved: boolean, stale: boolean, outdated: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!renderer) return
    const poll = () => {
      const entry = renderer.gi.describe().find(d => d.id === props.node.id)
      setStatus(entry ? {
        probes: entry.probes, captured: entry.captured, active: entry.active, idle: entry.idle,
        complete: renderer.gi.isCaptured(props.node),
        saved: GiBakeRegistry.has(props.node.bakeId), stale: renderer.gi.staleBakes.has(props.node.id),
        outdated: renderer.gi.outdatedBakes.has(props.node.id),
      } : null)
    }
    poll()
    const id = window.setInterval(poll, 500)
    return () => window.clearInterval(id)
  }, [renderer, props.node])

  // Save the capture as a bake: the scene keeps its id, the project storage its bytes, and the next load
  // (and a published game) takes it instead of capturing again.
  const saveBake = async () => {
    const scene = instance?.scene
    if (!renderer || !scene) return
    setSaving(true)
    try {
      const bytes = await renderer.gi.exportBake(props.node, scene)
      if (!bytes) { Logger.warn(`${props.node.name}: the capture is not complete yet`, 'Editor'); return }
      const id = newGiBakeId()
      await saveGiBake(id, bytes, props.node.bakeId)
      props.node.bakeId = id
      eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
      Logger.info(`Saved the GI bake of ${props.node.name} (${(bytes.byteLength / 1048576).toFixed(1)} MB)`, 'Editor')
    } catch (e) {
      Logger.warn(`Saving the GI bake of ${props.node.name} failed: ${e}`, 'Editor')
    } finally {
      setSaving(false)
    }
  }

  const spacing = props.node.worldSpacing
  const statusText = !status
    ? 'Not captured yet.'
    : status.captured < status.probes
      ? `Capturing · ${status.captured} / ${status.probes} probes`
      : `${status.active} of ${status.probes} probes lighting · ${status.probes - status.active} inside geometry or under the ground` +
        (status.idle ? '' : ' · relighting')

  return (
    <Collapsable title='GI Volume' icon={<GiVolumeIcon />} persistKey='giVolumeEditor'>
      <div className='w-full p-2 flex flex-col gap-2'>
        <DeclaredSections node={props.node} />
        <Hint>{`Spacing ${spacing.map(s => s.toFixed(2)).join(' x ')} m · ${props.node.probeCount} probes`}</Hint>
        <Hint>{statusText}</Hint>
        <Hint>{status?.stale
          ? 'The saved bake no longer matches this volume or the geometry round it: captured again. Save a new bake.'
          : status?.outdated
            ? 'The saved bake is from an older format: it loads, but Capture again and Save bake to take lamps and other small glowing things in evenly.'
          : status?.saved ? 'Saved bake: loads instead of capturing.' : 'No saved bake: captured each time the scene opens.'}</Hint>
        <div className='flex gap-2'>
          <Button size='sm' disabled={!status?.complete || saving}
            title='Save the capture with the project, so it loads instead of capturing again (and ships with a published game)'
            onClick={() => { void saveBake() }}>
            {saving ? 'Saving…' : 'Save bake'}
          </Button>
          <Button size='sm' title='Capture every probe again: after the static geometry inside the volume changed'
            onClick={() => {
              props.node.bakeId = null
              props.node.requestCapture()
              eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
            }}>
            Capture again
          </Button>
        </div>
      </div>
    </Collapsable>
  )
}
