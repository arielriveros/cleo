import { useState, useEffect } from 'react'
import { DirectionalLight, LightNode, PointLight, Spotlight, SpriteNode } from 'cleo'
import { vec3ToHex } from '../../../utils/UtilFunctions';
import { useEventBus } from '../../EventBusContext';
import Collapsable from '../../../components/Collapsable'
import { Button, ColorInput, PropertyTable, PropertyRow, NumberInput, Slider, Section, Toggle, Hint } from '../../../components/ui'
import { LightIcon } from '../sectionIcons'

// Re-exported so SkyAtmosphereEditor and VolumetricCloudsEditor keep resolving ColorInput from here.
export { ColorInput };

/** A punctual light is either kind; both carry the same three photometric properties. */
type Punctual = PointLight | Spotlight;

export default function LightEditor(props: {node: LightNode}) {
  const eventEmitter = useEventBus();
  const light = props.node.light;
  const markLightDirty = () => eventEmitter.emit('SCENE_CHANGED', { kind: 'light', node: props.node });

  const [castShadows, setCastShadows] = useState(props.node.castShadows);
  const [color, setColor] = useState(vec3ToHex(light.color));
  // One state bag for every numeric property; which of them are shown depends on the light type.
  const [values, setValues] = useState<{
    intensity: number, angularRadius: number,
    range: number, sourceRadius: number,
    cutOff: number, outerCutOff: number,
  }>({ intensity: 0, angularRadius: 0, range: 0, sourceRadius: 0, cutOff: 0, outerCutOff: 0 });
  const [legacy, setLegacy] = useState(false);

  const read = () => {
    const l = props.node.light;
    setValues({
      intensity: (l as DirectionalLight | Punctual).intensity,
      angularRadius: l instanceof DirectionalLight ? l.angularRadius : 0,
      range: l instanceof DirectionalLight ? 0 : (l as Punctual).range,
      sourceRadius: l instanceof DirectionalLight ? 0 : (l as Punctual).sourceRadius,
      cutOff: l instanceof Spotlight ? l.cutOff : 0,
      outerCutOff: l instanceof Spotlight ? l.outerCutOff : 0,
    });
    setLegacy(l.legacyFalloff);
  };

  useEffect(() => {
    setCastShadows(props.node.castShadows);
    setColor(vec3ToHex(props.node.light.color));
    read();
  }, [props.node])

  useEffect(() => {
    const editorSprite = props.node.getChildByName('__editor__LightSprite');
    if (editorSprite[0])
      (editorSprite[0] as SpriteNode).tint = [light.color[0], light.color[1], light.color[2]];
  }, [props.node, color])

  /** Write one property through to the light, then re-read: setters clamp, so the UI must follow. */
  const set = (patch: Partial<typeof values>) => {
    const l = props.node.light;
    if (patch.intensity !== undefined) (l as DirectionalLight | Punctual).intensity = Math.max(0, patch.intensity);
    if (patch.angularRadius !== undefined && l instanceof DirectionalLight) l.angularRadius = Math.max(0, patch.angularRadius);
    if (patch.range !== undefined && !(l instanceof DirectionalLight)) (l as Punctual).range = patch.range;
    if (patch.sourceRadius !== undefined && !(l instanceof DirectionalLight)) (l as Punctual).sourceRadius = patch.sourceRadius;
    if (l instanceof Spotlight) {
      if (patch.cutOff !== undefined) l.cutOff = patch.cutOff;
      if (patch.outerCutOff !== undefined) l.outerCutOff = patch.outerCutOff;
      // The outer cone must stay outside the inner one, or the falloff has nowhere to happen.
      if (l.outerCutOff <= l.cutOff) l.outerCutOff = l.cutOff + 0.01;
    }
    setValues(v => ({ ...v, ...patch }));
    read();
    markLightDirty();
  };

  const resetPhysical = () => {
    (props.node.light as Punctual).resetToPhysicalDefaults();
    read();
    markLightDirty();
  };

  const isDirectional = light instanceof DirectionalLight;
  const isSpot = light instanceof Spotlight;

  return (
    <Collapsable title='Light' icon={<LightIcon />} persistKey='light'>
    <div className='w-full p-2'>
      <Section title='Emission'>
        <PropertyTable columns={['40%', '60%']}>
          <PropertyRow label='Color'>
            <ColorInput color={color} onChange={(c) => { light.color = c; setColor(vec3ToHex(c)); markLightDirty(); }} />
          </PropertyRow>
          <PropertyRow label={isDirectional ? 'Intensity (lx)' : 'Intensity (lm)'} divider={!isDirectional}>
            <NumberInput value={values.intensity} min={0} step={isDirectional ? 1000 : 100}
              onChange={(v) => set({ intensity: v })} />
          </PropertyRow>
          {!isDirectional && <PropertyRow label='Range (m)'>
            <NumberInput value={values.range} min={0.01} step={0.5} onChange={(v) => set({ range: v })} />
          </PropertyRow>}
          {!isDirectional && <PropertyRow label='Source Radius (m)' divider={false}>
            <NumberInput value={values.sourceRadius} min={0} step={0.01} onChange={(v) => set({ sourceRadius: v })} />
          </PropertyRow>}
        </PropertyTable>

        {isDirectional
          ? <Hint>Illuminance in LUX. A clear midday sun is around 100,000; an overcast one 10,000.
              Brightness lives here, not in the colour — keep the colour as the light&apos;s tint.</Hint>
          : <Hint>Luminous power in LUMENS. A 100 W-equivalent bulb is about 1500; a candle about 12.
              Range is where the falloff reaches zero, and is also the light&apos;s culling radius.
              Source radius is how big the bulb is: it spreads the highlight into an image of the source
              rather than a point, dimming its peak by the same amount it widens. Dramatic on polished
              surfaces, invisible on rough ones.</Hint>}

        {legacy && <>
          <Hint>This light&apos;s numbers were converted from the old constant/linear/quadratic falloff,
            which had no physical scale — a lamp and the sun were both authored as colour 1. The
            conversion preserves how the light LOOKS, which is why the number is enormous. Reset it to
            re-author the light in real units.</Hint>
          <Button variant='subtle' className='mt-1 w-full' onClick={resetPhysical}>
            Reset to physical defaults
          </Button>
        </>}
      </Section>

      <Section title='Shadows'>
        <Toggle label='Cast Shadows' checked={castShadows} className='my-1'
          onChange={(c) => { props.node.castShadows = c; setCastShadows(c); markLightDirty(); }} />
        {props.node.type === 'directional'
          ? <Hint>The FIRST directional light with this on is the scene&apos;s sun: the renderer fits its
              shadow cascades around the camera for it. Tune them in Renderer mode.</Hint>
          : props.node.type === 'spotlight'
            ? <Hint>Spot lights get their own shadow map, sized to the outer cone and reaching as far as
                the light&apos;s range. A few can cast at once (see Spot Shadows in Renderer mode); any
                beyond that cap go unshadowed.</Hint>
            : <Hint>Point lights do not cast shadows — that needs a cubemap per light, which the
                renderer has no path for. The flag is still saved.</Hint>}
      </Section>

      { isSpot &&
        <Section title='Cone'>
          <Slider label='Inner Angle' min={0} max={80} step={0.5} value={values.cutOff}
            onChange={(v) => set({ cutOff: v })} />
          <Slider label='Outer Angle' min={0} max={80} step={0.5} value={values.outerCutOff}
            onChange={(v) => set({ outerCutOff: v })} />
          <Hint>Half-angles in degrees. Full brightness inside the inner cone, falling to nothing at the
            outer one. Narrowing the cone does not brighten the light — intensity is in lumens either
            way, so the beam shape and its brightness are independent.</Hint>
        </Section>
      }

      { isDirectional &&
        <Section title='Source'>
          <Slider label='Angular Radius' min={0} max={0.1} step={0.001} value={values.angularRadius}
            onChange={(v) => set({ angularRadius: v })} />
          <Hint>Apparent radius in radians; the real sun is 0.00465. It sets how broad the sun&apos;s
            reflection is — most visible on smooth, polished surfaces, and barely at all on rough ones.
            It also softens shadow edges, though only proportionally: a real penumbra widens with
            distance from whatever casts it, and that needs a blocker search this renderer has not got.</Hint>
        </Section>
      }
    </div>
    </Collapsable>
  )
}
