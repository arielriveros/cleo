import { useEffect, useState } from 'react'
import { AUTO_EXPOSURE_PRESETS, ExposureVolumeNode, type ExposureOverrides, type Preset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { DocScope, Hint, PresetMenu, SectionTitle } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../../EngineContext'
import { ExposureVolumeIcon } from '../sectionIcons'
import DeclaredSections, { useNodeTick } from '../../properties/DeclaredSections'
import ExposureSettingsFields, { type ExposureFieldKey, type ExposureFieldValues } from '@cleo/app-kit/renderer/ExposureSettingsFields'

// The Exposure Volume inspector. The volume is an oriented box (the node's full transform) inside which
// its overrides replace the scene's exposure settings; every field left unticked inherits the scene's. The
// box's rows are its declared properties (src/properties/clouds.ts); the overrides are the Rendering panel's
// exposure fields, each with a tick box.

export default function ExposureVolumeEditor(props: { node: ExposureVolumeNode }) {
  const { eventEmitter, instance } = useCleoEngine()
  const renderer = instance?.renderer
  useNodeTick(props.node)
  const changed = () => eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
  const applyPreset = (p: Preset<ExposureOverrides>) => { props.node.applyPreset(p); changed() }

  // What the scene would give each field: what an unticked row shows, and what ticking one starts from.
  const inherited = (): ExposureFieldValues => ({
    autoExposureEnabled: renderer?.autoExposureEnabled ?? true,
    ev100: renderer?.ev100 ?? 15,
    exposureCompensation: renderer?.exposureCompensation ?? 1,
    exposureCompensationCurve: renderer?.exposureCompensationCurve ?? [],
    exposureMinEV: renderer?.exposureMinEV ?? 2,
    exposureMaxEV: renderer?.exposureMaxEV ?? 17,
    exposureSpeedUp: renderer?.exposureSpeedUp ?? 3,
    exposureSpeedDown: renderer?.exposureSpeedDown ?? 1,
  })
  const scene = inherited()
  const values = { ...scene, ...props.node.overrides } as ExposureFieldValues

  // Whether the camera is inside, and how far: polled, since the camera moves without telling anyone.
  const [inside, setInside] = useState<{ weight: number, ev: number } | null>(null)
  useEffect(() => {
    if (!renderer) return
    const poll = () => {
      const hit = renderer.effectiveExposureSettings.volumes.find(x => x.id === props.node.id)
      setInside(hit ? { weight: hit.weight, ev: renderer.ev100 } : null)
    }
    poll()
    const id = window.setInterval(poll, 250)
    return () => window.clearInterval(id)
  }, [renderer, props.node])

  return (
    <Collapsable title='Exposure Volume' icon={<ExposureVolumeIcon />} persistKey='exposureVolumeEditor'
      right={<PresetMenu presets={AUTO_EXPOSURE_PRESETS} onApply={applyPreset} title='Exposure presets — override every field they set' />}>
      <div className='w-full p-2 flex flex-col gap-2'>
        <DeclaredSections node={props.node} />
        <Hint>{inside
          ? `Camera inside · weight ${inside.weight.toFixed(2)} · EV ${inside.ev.toFixed(2)}`
          : 'Camera outside: the scene\'s exposure applies.'}</Hint>
        <SectionTitle title='Overrides' />
        {/* The field terms are the Rendering panel's: the same settings, described once. */}
        <DocScope page='editor/rendering'>
          <ExposureSettingsFields
            values={values}
            meteredEV={inside?.ev}
            onChange={(patch) => {
              for (const [key, value] of Object.entries(patch)) props.node.setOverride(key as ExposureFieldKey, value as any)
              changed()
            }}
            override={{
              isOverridden: (key) => props.node.hasOverride(key),
              setOverridden: (key, on) => {
                // Ticking starts from the value the scene gives now, so nothing jumps.
                props.node.setOverride(key, on ? (inherited()[key] as any) : undefined)
                changed()
              },
            }} />
        </DocScope>
      </div>
    </Collapsable>
  )
}
