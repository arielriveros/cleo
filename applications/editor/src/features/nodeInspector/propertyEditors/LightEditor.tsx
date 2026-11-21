import { useEffect } from 'react'
import { LightNode, SpriteNode, applyPreset, lightPresetsFor, type LightPreset } from 'cleo'
import { useEventBus } from '../../EventBusContext';
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Button, ColorInput, PresetMenu, Hint } from '@cleo/app-kit/ui'
import { LightIcon } from '../sectionIcons'
import { cloudBakeWarning, useCloudBakeStatus } from '../../../utils/cloudBake'
import { lightBakeWarning, rebakeStale, useProbeBakeStatus } from '../../../utils/probeBake'
import { DeclaredSection } from '../../properties/DeclaredSections'

// Re-exported so SkyAtmosphereEditor and VolumetricCloudsEditor keep resolving ColorInput from here.
export { ColorInput };

// The Light inspector. Its rows are the light's declared properties (src/properties/environment.ts): which of
// them show follows the light's kind. The card adds what no type says: the presets, the bake warnings, and the
// way back to physical units for a light converted from the old falloff.

export default function LightEditor(props: {node: LightNode}) {
  const eventEmitter = useEventBus();
  const markLightDirty = () => eventEmitter.emit('SCENE_CHANGED', { kind: 'light', node: props.node });

  // The viewport's light sprite takes the light's colour, whatever changed it.
  useEffect(() => {
    const tint = () => {
      const sprite = props.node.getChildByName('__editor__LightSprite')[0] as SpriteNode | undefined;
      const c = props.node.light.color;
      if (sprite) sprite.tint = [c[0], c[1], c[2]];
    };
    tint();
    const onChange = (e: { node?: unknown }) => { if (!e?.node || e.node === props.node) tint(); };
    eventEmitter.on('SCENE_CHANGED', onChange);
    return () => { eventEmitter.off('SCENE_CHANGED', onChange); };
  }, [props.node, eventEmitter]);

  const light = props.node.light;
  const resetPhysical = () => {
    (props.node.light as any).resetToPhysicalDefaults();
    markLightDirty();
  };

  // The table follows the light's type, which a preset never changes. Shadows are left alone. Real values,
  // the same in every scene: how bright they read is the exposure's job.
  const presets = lightPresetsFor(light);
  const applyLightPreset = (p: LightPreset) => {
    applyPreset(props.node.light, presets, p);
    markLightDirty();
  };

  // Rotating the sun invalidates clouds baked into the sky (see VolumetricCloudsEditor › Sky Bake).
  const cloudBake = useCloudBakeStatus(props.node.scene);
  const cloudBakeStale = props.node.type === 'directional' && cloudBake.clouds && cloudBake.staleness === 'sun'
    ? cloudBakeWarning('sun') : null;
  // A light set to bake that changed since the light probes captured it.
  const probeBake = useProbeBakeStatus(props.node.scene);
  const staleProbes = probeBake.probesOf(props.node);
  const probeBakeStale = lightBakeWarning(props.node, staleProbes);

  return (
    <Collapsable title='Light' icon={<LightIcon />} persistKey='light'
      right={<PresetMenu presets={presets} onApply={applyLightPreset} title='Real-world lights, brightened as far as this scene needs to show them' />}>
    <div className='w-full p-2'>
      {probeBakeStale && <div className='flex items-center gap-2 mb-2'>
        <span className='text-warning text-ui flex-1'>{probeBakeStale}</span>
        <Button size='sm' onClick={() => { rebakeStale(staleProbes); eventEmitter.emit('SCENE_CHANGED'); }}>Re-bake probes</Button>
      </div>}
      {cloudBakeStale && <div className='flex items-center gap-2 mb-2'>
        <span className='text-warning text-ui flex-1'>Volumetric clouds are baked into the sky: this sun direction needs a new bake.</span>
        <Button size='sm' onClick={() => { cloudBake.clouds!.requestBake(); eventEmitter.emit('SCENE_CHANGED'); }}>Regenerate</Button>
      </div>}
      <DeclaredSection node={props.node} title='Emission'>
        {light.legacyFalloff && <>
          <Hint>This light&apos;s numbers were converted from the old constant/linear/quadratic falloff,
            which had no physical scale — a lamp and the sun were both authored as colour 1. The
            conversion preserves how the light LOOKS, which is why the number is enormous. Reset it to
            re-author the light in real units.</Hint>
          <Button variant='subtle' className='mt-1 w-full' onClick={resetPhysical}>
            Reset to physical defaults
          </Button>
        </>}
      </DeclaredSection>
      <DeclaredSection node={props.node} title='Shadows' />
      <DeclaredSection node={props.node} title='Baking' />
      <DeclaredSection node={props.node} title='Cone' />
      <DeclaredSection node={props.node} title='Emitter' />
      <DeclaredSection node={props.node} title='Source' />
    </div>
    </Collapsable>
  )
}
