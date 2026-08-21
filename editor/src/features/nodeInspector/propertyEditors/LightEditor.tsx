import { useState, useEffect } from 'react'
import { LightNode, PointLight, Spotlight, SpriteNode } from 'cleo'
import { vec3ToHex } from '../../../utils/UtilFunctions';
import { useEventBus } from '../../EventBusContext';
import Collapsable from '../../../components/Collapsable'
import { ColorInput, PropertyTable, PropertyRow, Slider, Section, Toggle, Hint } from '../../../components/ui'
import { LightIcon } from '../sectionIcons'

// The ColorInput now lives in the ui library; re-exported so existing importers
// (SkyAtmosphereEditor, VolumetricCloudsEditor) keep resolving it from here.
export { ColorInput };

export default function LightEditor(props: {node: LightNode}) {
  const eventEmitter = useEventBus();
  const light = props.node.light;
  const markLightDirty = () => eventEmitter.emit('SCENE_CHANGED', { kind: 'light', node: props.node });

  const [castShadows, setCastShadows] = useState(props.node.castShadows);
  const [diffuse, setDiffuse] = useState(vec3ToHex(light.diffuse));
  const [specular, setSpecular] = useState(vec3ToHex(light.specular));
  const [ambient, setAmbient] = useState(vec3ToHex(light.ambient));
  const [properties, setProperties] = useState<{constant?: number, linear?: number, quadratic?: number, cutOff?: number, outerCutOff?: number}>({
    constant: 0,
    linear: 0,
    quadratic: 0,
    cutOff: 0,
    outerCutOff: 0
  });

  useEffect(() => {
    setCastShadows(props.node.castShadows);
    setDiffuse(vec3ToHex(light.diffuse));
    setSpecular(vec3ToHex(light.specular));
    setAmbient(vec3ToHex(light.ambient));

    if (props.node.light instanceof PointLight) {
      setProperties({
        constant: (props.node.light as PointLight).constant,
        linear: (props.node.light as PointLight).linear,
        quadratic: (props.node.light as PointLight).quadratic
      });
    }

    if (props.node.light instanceof Spotlight) {
      setProperties({
        constant: (props.node.light as Spotlight).constant,
        linear: (props.node.light as Spotlight).linear,
        quadratic: (props.node.light as Spotlight).quadratic,
        cutOff: (props.node.light as Spotlight).cutOff,
        outerCutOff: (props.node.light as Spotlight).outerCutOff
      });
    }

  }, [props.node])

  useEffect(() => {
    if (props.node.light instanceof PointLight) {
      (props.node.light as PointLight).constant = properties.constant!;
      (props.node.light as PointLight).linear = properties.linear!;
      (props.node.light as PointLight).quadratic = properties.quadratic!;
    }
    if (props.node.light instanceof Spotlight) {
      (props.node.light as Spotlight).constant = properties.constant!;
      (props.node.light as Spotlight).linear = properties.linear!;
      (props.node.light as Spotlight).quadratic = properties.quadratic!;
      if (properties.cutOff! > properties.outerCutOff!) {
        // Outer cut off should be greater than cut off
        setProperties({...properties, outerCutOff: properties.cutOff! + 0.01});
        return;
      }
      (props.node.light as Spotlight).cutOff = properties.cutOff!;
      (props.node.light as Spotlight).outerCutOff = properties.outerCutOff!;
    }
  }, [properties])

  useEffect(() => {
    const editorSprite = props.node.getChildByName('__editor__LightSprite');
    if (editorSprite[0])
      (editorSprite[0] as SpriteNode).tint = [light.diffuse[0], light.diffuse[1], light.diffuse[2]];
  }, [props.node, diffuse])

  const set = (patch: Partial<typeof properties>) => {
    setProperties((prev) => ({ ...prev, ...patch }));
    markLightDirty();
  };

  return (
    <Collapsable title='Light' icon={<LightIcon />} persistKey='light'>
    <div className='w-full p-2'>
      <Section title='Colors'>
        <PropertyTable columns={['35%', '65%']}>
          <PropertyRow label='Diffuse'>
            <ColorInput color={diffuse} onChange={(color) => { light.diffuse = color; setDiffuse(vec3ToHex(color)); markLightDirty(); }} />
          </PropertyRow>
          <PropertyRow label='Specular'>
            <ColorInput color={specular} onChange={(color) => { light.specular = color; setSpecular(vec3ToHex(color)); markLightDirty(); }} />
          </PropertyRow>
          <PropertyRow label='Ambient' divider={false}>
            <ColorInput color={ambient} onChange={(color) => { light.ambient = color; setAmbient(vec3ToHex(color)); markLightDirty(); }} />
          </PropertyRow>
        </PropertyTable>
      </Section>

      <Section title='Shadows'>
        <Toggle label='Cast Shadows' checked={castShadows} className='my-1'
          onChange={(c) => { props.node.castShadows = c; setCastShadows(c); markLightDirty(); }} />
        {props.node.type === 'directional'
          ? <Hint>The FIRST directional light with this on is the scene&apos;s sun: the renderer fits its
              shadow cascades around the camera for it. Tune them in Renderer mode.</Hint>
          : props.node.type === 'spotlight'
            ? <Hint>Spot lights get their own shadow map, sized to the outer cone. A few can cast at
                once (see Spot Shadows in Renderer mode); any beyond that cap go unshadowed.</Hint>
            : <Hint>Point lights do not cast shadows — that needs a cubemap per light, which the
                renderer has no path for. The flag is still saved.</Hint>}
      </Section>

      { props.node.light instanceof PointLight &&
        <Section title='Point Light'>
          <Slider label='Constant' min={0} max={1} step={0.01} value={properties.constant ?? 0} onChange={(v) => set({ constant: v })} />
          <Slider label='Linear' min={0} max={1} step={0.01} value={properties.linear ?? 0} onChange={(v) => set({ linear: v })} />
          <Slider label='Quadratic' min={0} max={1} step={0.01} value={properties.quadratic ?? 0} onChange={(v) => set({ quadratic: v })} />
        </Section>
      }
      { props.node.light instanceof Spotlight &&
        <Section title='Spot Light'>
          <Slider label='Constant' min={0} max={1} step={0.1} value={properties.constant ?? 0} onChange={(v) => set({ constant: v })} />
          <Slider label='Linear' min={0} max={1} step={0.01} value={properties.linear ?? 0} onChange={(v) => set({ linear: v })} />
          <Slider label='Quadratic' min={0} max={1} step={0.001} value={properties.quadratic ?? 0} onChange={(v) => set({ quadratic: v })} />
          <Slider label='Cut Off' min={0} max={60} step={0.01} value={properties.cutOff ?? 0} onChange={(v) => set({ cutOff: v })} />
          <Slider label='Outer Cut' min={0} max={60} step={0.01} value={properties.outerCutOff ?? 0} onChange={(v) => set({ outerCutOff: v })} />
        </Section>
      }
    </div>
    </Collapsable>
  )
}
