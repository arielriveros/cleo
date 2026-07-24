import { useState, useEffect } from 'react';
import { ModelNode, Material, CustomMaterial } from 'cleo';
import { useEventBus } from '../../EventBusContext';
import { vec3ToHex } from '../../../utils/UtilFunctions';
import { newCustomMaterial } from '../../../utils/customMaterials';
import Collapsable from '../../../components/Collapsable';
import TextureInspector from './TextureInspector';
import CustomMaterialEditor from './CustomMaterialEditor';
import { PropertyTable, PropertyRow, Field, Select, NumberInput, Slider, Toggle, ColorInput, Section } from '../../../components/ui';
import { MaterialIcon } from '../sectionIcons';

export default function MaterialEditor(props: {node: ModelNode}) {
  // Safety check to ensure the node has a model
  if (!props.node.model) {
    return <div>No model available for this node.</div>;
  }
  
  const model = props.node.model;
  const material = model.material;

  // Shader selection (basic | blinn_phong | pbr | custom)
  type ShaderType = 'basic' | 'blinn_phong' | 'pbr' | 'custom';
  const detectShaderType = (t: string): ShaderType =>
    t.startsWith('custom') ? 'custom'
    : (t.includes('blinn_phong') || t.includes('default')) ? 'blinn_phong' : t.includes('pbr') ? 'pbr' : 'basic';
  const [shaderType, setShaderType] = useState<ShaderType>(detectShaderType(material.type as string));

  // Default shader state
  const [diffuse, setDiffuse] = useState(vec3ToHex(material.properties.get('diffuse')));
  const [specular, setSpecular] = useState(vec3ToHex(material.properties.get('specular')));
  const [ambient, setAmbient] = useState(vec3ToHex(material.properties.get('ambient')));
  const [shininess, setShininess] = useState(material.properties.get('shininess') || 32);
  const [emission, setEmission] = useState(vec3ToHex(material.properties.get('emissive')));

  // PBR shader state
  const [baseColor, setBaseColor] = useState<string>(vec3ToHex(material.properties.get('baseColor') || [1,1,1]));
  const [metallic, setMetallic] = useState<number>(material.properties.get('metallic') ?? 0);
  const [roughness, setRoughness] = useState<number>(material.properties.get('roughness') ?? 1);
  const [emissiveFactor, setEmissiveFactor] = useState<string>(vec3ToHex(material.properties.get('emissiveFactor') || [0,0,0]));
  const [pbrOpacity, setPbrOpacity] = useState<number>(material.properties.get('opacity') ?? 1);
  // Add default shader opacity state
  const [defaultOpacity, setDefaultOpacity] = useState<number>(material.properties.get('opacity') ?? 1);

  // Basic shader state
  const [basicColor, setBasicColor] = useState(
    vec3ToHex(material.properties.get('color') ?? [1,1,1])
  );
  const [basicOpacity, setBasicOpacity] = useState<number>(
    material.properties.get('opacity') ?? 1
  );

  // Options state
  const [options, setOptions] = useState<{ wireframe: boolean; transparent: boolean; side: 'front' | 'back' | 'double'; castShadow: boolean; probeable: boolean;}>(
  {
    wireframe: material.config.wireframe ?? false,
    transparent: material.config.transparent ?? false,
    side: material.config.side ?? 'front',
    castShadow: material.config.castShadow ?? false,
    probeable: material.config.probeable ?? true,
  });

  useEffect(() => {
    // Sync shader type and values from material when node changes
    setShaderType(detectShaderType(material.type as string));

    setDiffuse(vec3ToHex(material.properties.get('diffuse')));
    setSpecular(vec3ToHex(material.properties.get('specular')));
    setAmbient(vec3ToHex(material.properties.get('ambient')));
    setShininess(material.properties.get('shininess') || 32);
    setEmission(vec3ToHex(material.properties.get('emissive')));

    setBaseColor(vec3ToHex(material.properties.get('baseColor') || [1,1,1]));
    setMetallic(material.properties.get('metallic') ?? 0);
    setRoughness(material.properties.get('roughness') ?? 1);
    setEmissiveFactor(vec3ToHex(material.properties.get('emissiveFactor') || [0,0,0]));
    setPbrOpacity(material.properties.get('opacity') ?? 1);
    // Sync default opacity
    setDefaultOpacity(material.properties.get('opacity') ?? 1);

    setBasicColor(vec3ToHex(material.properties.get('color') ?? [1,1,1]));
    setBasicOpacity(material.properties.get('opacity') ?? 1);

    setOptions({
      wireframe: material.config.wireframe ?? false,
      transparent: material.config.transparent ?? false,
      side: material.config.side ?? 'front',
      castShadow: material.config.castShadow ?? false,
      probeable: material.config.probeable ?? true,
    });

  }, [props.node])

  // Apply shader type change to material
  useEffect(() => {
    // Custom materials own their own type key (a content hash) + properties — the CustomMaterialEditor
    // manages them, and the instance swap to/from CustomMaterial happens in handleShaderTypeChange.
    if (shaderType === 'custom') return;

    // Update material.type to selected shader
    material.type = shaderType as any;

    // Ensure required properties exist for selected shader
    if (shaderType === 'basic') {
      const carried = material.properties.get('color') || material.properties.get('baseColor') || material.properties.get('diffuse') || [1,1,1];
      material.properties.set('color', carried);
      if (material.properties.get('opacity') === undefined) material.properties.set('opacity', 1.0);
      // Flag for single texture in basic
      if (material.properties.get('hasTexture') === undefined) material.properties.set('hasTexture', false);
    } else if (shaderType === 'blinn_phong') {
      // Blinn-Phong shader required props — carry the main color/emissive over from PBR/basic so the
      // object keeps its look after a type switch instead of resetting to white.
      const carried = material.properties.get('diffuse') || material.properties.get('baseColor') || material.properties.get('color') || [1,1,1];
      material.properties.set('diffuse', carried);
      if (!material.properties.get('specular')) material.properties.set('specular', [1,1,1]);
      if (!material.properties.get('ambient')) material.properties.set('ambient', carried);
      if (!material.properties.get('emissive')) material.properties.set('emissive', material.properties.get('emissiveFactor') || [0,0,0]);
      if (material.properties.get('shininess') === undefined) material.properties.set('shininess', 32.0);
      if (material.properties.get('opacity') === undefined) material.properties.set('opacity', 1.0);
      if (material.properties.get('reflectivity') === undefined) material.properties.set('reflectivity', 0.0);
    } else if (shaderType === 'pbr') {
      // Carry the main color/emissive over from default/basic so the object keeps its look.
      const carried = material.properties.get('baseColor') || material.properties.get('diffuse') || material.properties.get('color') || [1,1,1];
      material.properties.set('baseColor', carried);
      if (material.properties.get('metallic') === undefined) material.properties.set('metallic', 0.0);
      if (material.properties.get('roughness') === undefined) material.properties.set('roughness', 1.0);
      if (material.properties.get('opacity') === undefined) material.properties.set('opacity', 1.0);
      if (!material.properties.get('emissiveFactor')) material.properties.set('emissiveFactor', material.properties.get('emissive') || [0,0,0]);
      if (material.properties.get('hasBaseColorTexture') === undefined) material.properties.set('hasBaseColorTexture', false);
      if (material.properties.get('hasMetallicRoughnessTexture') === undefined) material.properties.set('hasMetallicRoughnessTexture', false);
      if (material.properties.get('hasNormalMap') === undefined) material.properties.set('hasNormalMap', false);
      if (material.properties.get('hasOcclusionMap') === undefined) material.properties.set('hasOcclusionMap', false);
      if (material.properties.get('hasEmissiveMap') === undefined) material.properties.set('hasEmissiveMap', false);
    }
  }, [shaderType, material]);

  // Apply options changes back to the material config
  useEffect(() => {
    material.config.wireframe = options.wireframe;
    material.config.transparent = options.transparent;
    material.config.side = options.side;
    material.config.castShadow = options.castShadow;
    material.config.probeable = options.probeable;
  }, [options, material])

  const eventEmitter = useEventBus();

  useEffect(() => { eventEmitter.emit('TEXTURES_CHANGED') }, [])

  // Switching the shader type to/from 'custom' swaps the material INSTANCE (a CustomMaterial subclass),
  // carrying the config across. Built-in <-> built-in stays on the same instance (the effect above seeds
  // the required properties). Read model.material fresh each render so the swap is picked up.
  const handleShaderTypeChange = (next: ShaderType) => {
    const cur = detectShaderType(model.material.type as string);
    if (next === cur) return;
    const cfg = { ...model.material.config };
    if (next === 'custom') {
      model.material = newCustomMaterial('pbr', 'forward', cfg);
    } else if (cur === 'custom') {
      model.material = next === 'basic' ? Material.Basic({}, cfg)
        : next === 'pbr' ? Material.PBR({}, cfg)
        : Material.Default({}, cfg);
    }
    setShaderType(next);
    eventEmitter.emit('SCENE_CHANGED');
  };

  const markMaterialDirty = () => eventEmitter.emit('SCENE_CHANGED', { kind: 'material', node: props.node });
  const setColor = (key: string, setter: (hex: string) => void) => (c: [number, number, number]) => {
    model.material.properties.set(key, c);
    setter(vec3ToHex(c));
    markMaterialDirty();
  };
  const setNum = (key: string, setter: (v: number) => void) => (v: number) => {
    model.material.properties.set(key, v);
    setter(v);
    markMaterialDirty();
  };
  const updateOption = (patch: Partial<typeof options>) => { setOptions((prev) => ({ ...prev, ...patch })); markMaterialDirty(); };

  // Rendered as a function call (not a component) so the TextureInspector at each position stays
  // mounted across re-renders instead of remounting.
  const texSlot = (label: string, tex: string) => (
    <div className='flex flex-col items-center gap-1'>
      <span className='text-[10px] text-muted'>{label}</span>
      <TextureInspector tex={tex} material={model.material} />
    </div>
  );

  return (
    <Collapsable title='Material' icon={<MaterialIcon />} persistKey='material'>
      <div className='w-full p-2'>
        <Field label='Shader'>
          <Select value={shaderType} onChange={(e) => handleShaderTypeChange(e.target.value as ShaderType)}>
            <option value='basic'>Basic</option>
            <option value='blinn_phong'>Blinn-Phong</option>
            <option value='pbr'>PBR</option>
            <option value='custom'>Custom (shader)</option>
          </Select>
        </Field>

        {shaderType === 'custom' && <CustomMaterialEditor node={props.node} />}

        {shaderType === 'blinn_phong' && (
          <>
            <Section title='Colors'>
              <PropertyTable columns={['40%', '60%']}>
                <PropertyRow label='Diffuse'><ColorInput color={diffuse} onChange={setColor('diffuse', setDiffuse)} /></PropertyRow>
                <PropertyRow label='Specular'><ColorInput color={specular} onChange={setColor('specular', setSpecular)} /></PropertyRow>
                <PropertyRow label='Ambient'><ColorInput color={ambient} onChange={setColor('ambient', setAmbient)} /></PropertyRow>
                <PropertyRow label='Emission'><ColorInput color={emission} onChange={setColor('emissive', setEmission)} /></PropertyRow>
                <PropertyRow label='Shininess'><NumberInput value={Number(shininess)} onChange={setNum('shininess', setShininess)} /></PropertyRow>
                <PropertyRow label='Opacity' divider={false}><Slider min={0} max={1} step={0.01} value={defaultOpacity} onChange={setNum('opacity', setDefaultOpacity)} /></PropertyRow>
              </PropertyTable>
            </Section>
            <Section title='Textures'>
              <div className='flex flex-wrap gap-3'>
                {texSlot('Diffuse', 'baseTexture')}
                {texSlot('Specular', 'specularMap')}
                {texSlot('Normal', 'normalMap')}
                {texSlot('Emission', 'emissiveMap')}
                {texSlot('Mask', 'maskMap')}
                {texSlot('Reflectivity', 'reflectivityMap')}
              </div>
            </Section>
          </>
        )}

        {shaderType === 'basic' && (
          <>
            <Section title='Properties'>
              <PropertyTable columns={['40%', '60%']}>
                <PropertyRow label='Color'><ColorInput color={basicColor} onChange={setColor('color', setBasicColor)} /></PropertyRow>
                <PropertyRow label='Opacity' divider={false}><Slider min={0} max={1} step={0.01} value={basicOpacity} onChange={setNum('opacity', setBasicOpacity)} /></PropertyRow>
              </PropertyTable>
            </Section>
            <Section title='Texture'>
              <div className='flex flex-wrap gap-3'>{texSlot('Texture', 'texture')}</div>
            </Section>
          </>
        )}

        {shaderType === 'pbr' && (
          <>
            <Section title='Properties'>
              <PropertyTable columns={['40%', '60%']}>
                <PropertyRow label='Base Color'><ColorInput color={baseColor} onChange={setColor('baseColor', setBaseColor)} /></PropertyRow>
                <PropertyRow label='Metallic'><Slider min={0} max={1} step={0.01} value={metallic} onChange={setNum('metallic', setMetallic)} /></PropertyRow>
                <PropertyRow label='Roughness'><Slider min={0} max={1} step={0.01} value={roughness} onChange={setNum('roughness', setRoughness)} /></PropertyRow>
                <PropertyRow label='Opacity'><Slider min={0} max={1} step={0.01} value={pbrOpacity} onChange={setNum('opacity', setPbrOpacity)} /></PropertyRow>
                <PropertyRow label='Emissive' divider={false}><ColorInput color={emissiveFactor} onChange={setColor('emissiveFactor', setEmissiveFactor)} /></PropertyRow>
              </PropertyTable>
            </Section>
            <Section title='Textures'>
              <div className='flex flex-wrap gap-3'>
                {texSlot('Base Color', 'baseColorTexture')}
                {texSlot('Metal+Rough', 'metallicRoughnessTexture')}
                {texSlot('Normal', 'normalMap')}
                {texSlot('Occlusion', 'occlusionMap')}
                {texSlot('Emissive', 'emissiveMap')}
              </div>
            </Section>
          </>
        )}

        <Section title='Options'>
          <div className='flex flex-col gap-1.5'>
            <Toggle label='Wireframe' checked={options.wireframe} onChange={(c) => updateOption({ wireframe: c })} />
            <Toggle label='Transparent' checked={options.transparent} onChange={(c) => updateOption({ transparent: c })} />
            <Toggle label='Cast Shadow' checked={options.castShadow} onChange={(c) => updateOption({ castShadow: c })} />
            <Toggle label='Probeable' checked={options.probeable} onChange={(c) => updateOption({ probeable: c })} />
            <Field label='Side'>
              <Select value={options.side} onChange={(e) => updateOption({ side: e.target.value as 'front' | 'back' | 'double' })}>
                <option value='front'>Front</option>
                <option value='back'>Back</option>
                <option value='double'>Both</option>
              </Select>
            </Field>
          </div>
        </Section>
      </div>
    </Collapsable>
  )
}
