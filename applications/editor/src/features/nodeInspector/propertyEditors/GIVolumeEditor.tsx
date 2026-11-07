import { useEffect, useState } from 'react'
import { GIVolumeNode, GiBakeRegistry, Logger, MAX_GI_PROBES_PER_AXIS, MIN_GI_PROBES_PER_AXIS, newGiBakeId } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Button, Hint, NumberInput, PropertyRow, PropertyTable, Select, Toggle, VectorInput } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../../EngineContext'
import { GiVolumeIcon } from '../sectionIcons'
import { BOX_VOLUME_EDITED } from '../../gizmo/BoxVolumeGizmo'
import { saveGiBake } from '../../../utils/giBakeStore'

// The GI Volume inspector. The volume is an oriented box (the node's full transform) filled corner to
// corner with a grid of irradiance probes; the renderer captures what each probe's rays hit and relights
// them as the light changes (render/gi/giSystem.ts).

interface Fields {
  enabled: boolean
  size: [number, number, number]
  probeCounts: [number, number, number]
  rays: number
  maxRayDistance: number
  captureResolution: number
  blendDistance: number
  intensity: number
  normalBias: number
  viewBias: number
  multiBounce: boolean
  includeGrass: boolean
}

export default function GIVolumeEditor(props: { node: GIVolumeNode }) {
  const { eventEmitter, instance } = useCleoEngine()
  const renderer = instance?.renderer
  const read = (): Fields => {
    const n = props.node
    return {
      enabled: n.enabled, size: [...n.size] as [number, number, number],
      probeCounts: [...n.probeCounts] as [number, number, number], rays: n.rays, maxRayDistance: n.maxRayDistance,
      captureResolution: n.captureResolution, blendDistance: n.blendDistance, intensity: n.intensity,
      normalBias: n.normalBias, viewBias: n.viewBias, multiBounce: n.multiBounce, includeGrass: n.includeGrass,
    }
  }
  const [v, setV] = useState(read)
  useEffect(() => { setV(read()) }, [props.node])

  // The viewport's face handles resize the box behind this panel's back.
  useEffect(() => {
    const onEdited = (e: { nodeId: string }) => { if (e?.nodeId === props.node.id) setV(read()) }
    eventEmitter.on(BOX_VOLUME_EDITED, onEdited)
    return () => { eventEmitter.off(BOX_VOLUME_EDITED, onEdited) }
  }, [eventEmitter, props.node])

  const set = (patch: Partial<Fields>) => {
    const n = props.node
    if (patch.enabled !== undefined) n.enabled = patch.enabled
    if (patch.size !== undefined) n.size = patch.size
    if (patch.probeCounts !== undefined) n.probeCounts = patch.probeCounts
    if (patch.rays !== undefined) n.rays = patch.rays
    if (patch.maxRayDistance !== undefined) n.maxRayDistance = patch.maxRayDistance
    if (patch.captureResolution !== undefined) n.captureResolution = patch.captureResolution
    if (patch.blendDistance !== undefined) n.blendDistance = patch.blendDistance
    if (patch.intensity !== undefined) n.intensity = patch.intensity
    if (patch.normalBias !== undefined) n.normalBias = patch.normalBias
    if (patch.viewBias !== undefined) n.viewBias = patch.viewBias
    if (patch.multiBounce !== undefined) n.multiBounce = patch.multiBounce
    if (patch.includeGrass !== undefined) n.includeGrass = patch.includeGrass
    setV(read())
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
  }

  // How far the capture has got: polled, since it runs a batch at a time on render frames.
  const [status, setStatus] = useState<{ probes: number, captured: number, active: number, idle: boolean,
                                         complete: boolean, saved: boolean, stale: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!renderer) return
    const poll = () => {
      const entry = renderer.gi.describe().find(d => d.id === props.node.id)
      setStatus(entry ? {
        probes: entry.probes, captured: entry.captured, active: entry.active, idle: entry.idle,
        complete: renderer.gi.isCaptured(props.node),
        saved: GiBakeRegistry.has(props.node.bakeId), stale: renderer.gi.staleBakes.has(props.node.id),
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
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Enabled' divider>
            <Toggle checked={v.enabled} onChange={enabled => set({ enabled })} />
          </PropertyRow>
          <PropertyRow label='Size' divider>
            <VectorInput value={v.size} min={0.01} step={0.5} onChange={size => set({ size: size as [number, number, number] })} />
          </PropertyRow>
          <PropertyRow label='Probes' divider>
            <VectorInput value={v.probeCounts} min={MIN_GI_PROBES_PER_AXIS} max={MAX_GI_PROBES_PER_AXIS} step={1}
              onChange={c => set({ probeCounts: c.map(x => Math.round(x)) as [number, number, number] })} />
          </PropertyRow>
          <PropertyRow label='Rays' divider>
            <Select value={String(v.rays)} onChange={e => set({ rays: Number(e.target.value) })}>
              <option value='64'>64 (8 x 8)</option>
              <option value='256'>256 (16 x 16)</option>
            </Select>
          </PropertyRow>
          <PropertyRow label='Ray reach' divider>
            <NumberInput value={v.maxRayDistance} min={1} max={2000} step={1} onChange={maxRayDistance => set({ maxRayDistance })} />
          </PropertyRow>
          <PropertyRow label='Capture resolution' divider>
            <Select value={String(v.captureResolution)} onChange={e => set({ captureResolution: Number(e.target.value) })}>
              <option value='16'>16 px</option>
              <option value='32'>32 px</option>
            </Select>
          </PropertyRow>
          <PropertyRow label='Blend distance' divider>
            <NumberInput value={v.blendDistance} min={0} step={0.1} onChange={blendDistance => set({ blendDistance })} />
          </PropertyRow>
          <PropertyRow label='Intensity' divider>
            <NumberInput value={v.intensity} min={0} step={0.05} onChange={intensity => set({ intensity })} />
          </PropertyRow>
          <PropertyRow label='Normal bias' divider>
            <NumberInput value={v.normalBias} min={0} max={2} step={0.05} onChange={normalBias => set({ normalBias })} />
          </PropertyRow>
          <PropertyRow label='View bias' divider>
            <NumberInput value={v.viewBias} min={0} max={2} step={0.05} onChange={viewBias => set({ viewBias })} />
          </PropertyRow>
          <PropertyRow label='Multi-bounce' divider>
            <Toggle checked={v.multiBounce} onChange={multiBounce => set({ multiBounce })} />
          </PropertyRow>
          <PropertyRow label='Include grass' divider={false}>
            <Toggle checked={v.includeGrass} onChange={includeGrass => set({ includeGrass })} />
          </PropertyRow>
        </PropertyTable>
        <Hint>{`Spacing ${spacing.map(s => s.toFixed(2)).join(' x ')} m · ${props.node.probeCount} probes`}</Hint>
        <Hint>{statusText}</Hint>
        <Hint>{status?.stale
          ? 'The saved bake no longer matches this volume or the geometry round it: captured again. Save a new bake.'
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
