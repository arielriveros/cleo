import { VolumetricCloudsNode, VOLUMETRIC_CLOUDS_PRESETS, type VolumetricCloudsPreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useEventBus } from '../../EventBusContext'
import { Button, Hint, PresetMenu } from '@cleo/app-kit/ui'
import { cloudBakeWarning, formatBakeAge, useCloudBakeStatus } from '../../../utils/cloudBake'
import { CloudsIcon } from '../sectionIcons'
import { DeclaredSection, useNodeTick } from '../../properties/DeclaredSections'

// The Volumetric Clouds inspector: the clouds' declared properties (src/properties/clouds.ts), section by section,
// with the card's own lines: how the clouds follow the Wind node, and the sky bake's state and Regenerate.

export default function VolumetricCloudsEditor(props: { node: VolumetricCloudsNode }) {
  const eventEmitter = useEventBus()
  useNodeTick(props.node)
  const n = props.node

  const bake = useCloudBakeStatus(n.scene)
  const bakeWarning = n.bakeIntoSky ? cloudBakeWarning(bake.staleness) : null
  const regenerate = () => { n.requestBake(); eventEmitter.emit('SCENE_CHANGED') }

  const applyPreset = (p: VolumetricCloudsPreset) => {
    n.applyPreset(p)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: n })
  }

  // Read at render: adding a Wind node selects it anyway.
  const sceneWind = n.scene?.wind ?? null

  return (
    <Collapsable title='Volumetric Clouds' icon={<CloudsIcon />} persistKey='volumetricClouds'
      right={<PresetMenu presets={VOLUMETRIC_CLOUDS_PRESETS} onApply={applyPreset} title='Cloud presets' />}>
      <div className='w-full p-2'>
        <DeclaredSection node={n} title='' />
        <DeclaredSection node={n} title='Shape' />
        <DeclaredSection node={n} title='Lighting' />
        <DeclaredSection node={n} title='Multiple Scattering' />
        <DeclaredSection node={n} title='Animation'>
          {n.useSceneWind && (sceneWind
            ? <Hint>Blowing the way Wind ‘{sceneWind.name}’ does. Wind Speed is the altitude wind at its
                Strength 1 — the Wind node’s Strength scales it, and 0 stills the sky.</Hint>
            : <Hint>No Wind node in the scene — the clouds use the direction above.</Hint>)}
        </DeclaredSection>
        <DeclaredSection node={n} title='Sky Bake'>
          {n.bakeIntoSky && <>
            {!bake.hasAtmosphere && <Hint>The bake paints the clouds over the Sky Atmosphere — add one, or the clouds stay live.</Hint>}
            <div className='flex items-center gap-2 my-1'>
              <Button size='sm' onClick={regenerate} disabled={!bake.hasAtmosphere}>Regenerate</Button>
              <span className='text-ui text-muted'>
                {bake.age === null ? 'Not baked yet' : `Baked ${formatBakeAge(bake.age)}`}
              </span>
            </div>
            {bakeWarning && <div className='text-warning text-ui my-1'
              title='Play mode re-bakes at load anyway; this is about the preview, and about a sun animated during play when re-baking is off.'>
              {bakeWarning}</div>}
          </>}
        </DeclaredSection>
        <DeclaredSection node={n} title='Quality' />
      </div>
    </Collapsable>
  )
}
