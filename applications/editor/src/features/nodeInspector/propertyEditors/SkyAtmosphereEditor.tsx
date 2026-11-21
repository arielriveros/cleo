import { SkyAtmosphereNode, SKY_ATMOSPHERE_PRESETS, sceneSunLux, type SkyAtmospherePreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useEventBus } from '../../EventBusContext'
import { Hint, PresetMenu } from '@cleo/app-kit/ui'
import { SkyIcon } from '../sectionIcons'
import { DeclaredSection, useNodeTick } from '../../properties/DeclaredSections'

// The Sky Atmosphere inspector: its declared properties (src/properties/sky.ts), section by section, with the
// card's own lines where the sky explains itself (lit by the scene sun's lux; a moon saved as a fraction).

const SECTIONS = ['Atmosphere', 'Night Sky'] as const
const AFTER = ['Quality', 'Fog (aerial perspective)', 'God Rays (volumetric light shafts)'] as const

export default function SkyAtmosphereEditor(props: { node: SkyAtmosphereNode }) {
  const eventEmitter = useEventBus()
  useNodeTick(props.node)

  const applyPreset = (p: SkyAtmospherePreset) => {
    props.node.applyPreset(p)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
  }
  const n = props.node

  return (
    <Collapsable title='Sky Atmosphere' icon={<SkyIcon />} persistKey='skyAtmosphere'
      right={<PresetMenu presets={SKY_ATMOSPHERE_PRESETS} onApply={applyPreset} title='Air and fog presets' />}>
      <div className='w-full p-2'>
        <DeclaredSection node={n} title='Sun'>
          {n.useSceneSun && n.physicalUnits &&
            <Hint>Lit by the scene sun's own {Math.round(sceneSunLux(n)).toLocaleString()} lux, so the sky, the sun disc and their reflections match what the sun lights. Exposure below trims it.</Hint>}
        </DeclaredSection>
        {SECTIONS.map(title => <DeclaredSection key={title} node={n} title={title} />)}
        <DeclaredSection node={n} title='Moon'>
          {n.nightEnabled && n.moonEnabled && n.usesLegacyMoonRatio &&
            <Hint>Saved as a fraction of the sun, so it moves whenever the sun's lux does. Editing it stores lux.</Hint>}
        </DeclaredSection>
        {AFTER.map(title => <DeclaredSection key={title} node={n} title={title} />)}
      </div>
    </Collapsable>
  )
}
