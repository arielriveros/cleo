import { useEffect, useState } from 'react'
import { ModelNode, WaterVolumeNode, WATER_VOLUME_PRESETS, type WaterVolumePreset } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import { NumberInput, PresetMenu, PropertyRow, PropertyTable, Select, Toggle, VectorInput } from '../../../components/ui'
import NodeRefInput from '../NodeRefInput'
import { useCleoEngine } from '../../EngineContext'
import { WaterVolumeIcon } from '../sectionIcons'

// The Water Volume inspector. The volume is an axis-aligned box whose TOP face is the water surface; the
// physics buoys every dynamic body inside it by its mass against the water it displaces.

export default function WaterVolumeEditor(props: { node: WaterVolumeNode }) {
  const { eventEmitter, editorScene, templates } = useCleoEngine()
  const read = () => ({
    size: [...props.node.size], density: props.node.density, linearDrag: props.node.linearDrag,
    angularDrag: props.node.angularDrag, waveAmplitude: props.node.waveAmplitude,
    waveFrequency: props.node.waveFrequency, affectCharacters: props.node.affectCharacters,
    surfaceNodeId: props.node.surfaceNodeId, splashTemplate: props.node.splashTemplate, enabled: props.node.enabled,
  })
  const [v, setV] = useState(read)
  useEffect(() => { setV(read()) }, [props.node])

  const set = (patch: Partial<ReturnType<typeof read>>) => {
    const n = props.node
    if (patch.size !== undefined) n.size = patch.size as [number, number, number]
    if (patch.density !== undefined) n.density = patch.density
    if (patch.linearDrag !== undefined) n.linearDrag = patch.linearDrag
    if (patch.angularDrag !== undefined) n.angularDrag = patch.angularDrag
    if (patch.waveAmplitude !== undefined) n.waveAmplitude = patch.waveAmplitude
    if (patch.waveFrequency !== undefined) n.waveFrequency = patch.waveFrequency
    if (patch.affectCharacters !== undefined) n.affectCharacters = patch.affectCharacters
    if (patch.surfaceNodeId !== undefined) n.surfaceNodeId = patch.surfaceNodeId
    if (patch.splashTemplate !== undefined) n.splashTemplate = patch.splashTemplate
    if (patch.enabled !== undefined) n.enabled = patch.enabled
    setV(read())
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  }

  const applyPreset = (p: WaterVolumePreset) => {
    props.node.applyPreset(p)
    setV(read())
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  }

  return (
    <Collapsable title='Water Volume' icon={<WaterVolumeIcon />} persistKey='waterVolumeEditor'
      right={<PresetMenu presets={WATER_VOLUME_PRESETS} onApply={applyPreset} title='Liquid presets' />}>
      <div className='p-2 flex flex-col gap-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Enabled' divider>
            <Toggle checked={v.enabled} onChange={enabled => set({ enabled })} />
          </PropertyRow>
          <PropertyRow label='Size' hint='Width, depth, length in metres, before the node scale. The top face is the water surface.' divider>
            <VectorInput value={v.size} min={0} step={0.25} onChange={size => set({ size })} />
          </PropertyRow>
          <PropertyRow label='Density' hint='kg/m³ (fresh water 1000). A body denser than this sinks; lighter ones float, riding higher the lighter they are.' divider>
            <NumberInput value={v.density} min={1} step={25} onChange={density => set({ density })} />
          </PropertyRow>
          <PropertyRow label='Drag' hint='Per second, at full submersion: how quickly bodies in the water slow down.' divider>
            <NumberInput value={v.linearDrag} min={0} step={0.1} onChange={linearDrag => set({ linearDrag })} />
          </PropertyRow>
          <PropertyRow label='Spin drag' hint='Per second, at full submersion: how quickly a body stops tumbling.' divider>
            <NumberInput value={v.angularDrag} min={0} step={0.1} onChange={angularDrag => set({ angularDrag })} />
          </PropertyRow>
          <PropertyRow label='Swell' hint='Metres the surface rises and falls, so floating bodies bob. 0 = flat.' divider>
            <NumberInput value={v.waveAmplitude} min={0} step={0.01} onChange={waveAmplitude => set({ waveAmplitude })} />
          </PropertyRow>
          <PropertyRow label='Swell rate' hint='Hz.' divider>
            <NumberInput value={v.waveFrequency} min={0} step={0.05} onChange={waveFrequency => set({ waveFrequency })} />
          </PropertyRow>
          <PropertyRow label='Buoy characters' hint='Off: character capsules are mostly air and would be launched out of the water.' divider>
            <Toggle checked={v.affectCharacters} onChange={affectCharacters => set({ affectCharacters })} />
          </PropertyRow>
          <PropertyRow label='Surface' hint='The model showing the water. If its custom material declares vec4 uniforms ripple0..ripple11, they are filled with ripples from what moves through the water.' divider>
            <NodeRefInput value={v.surfaceNodeId} scene={editorScene} filter={n => n instanceof ModelNode}
              onChange={surfaceNodeId => set({ surfaceNodeId })} />
          </PropertyRow>
          <PropertyRow label='Splash' hint='Template spawned at the surface where something enters the water or wades through it.'>
            <Select value={v.splashTemplate} onChange={e => set({ splashTemplate: e.target.value })}>
              <option value=''>None</option>
              {(templates ?? []).map((t: any) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </Select>
          </PropertyRow>
        </PropertyTable>
      </div>
    </Collapsable>
  )
}
