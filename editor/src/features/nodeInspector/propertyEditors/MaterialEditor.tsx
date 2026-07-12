import { useState, useEffect } from 'react';
import { ModelNode, Material, CustomMaterial } from 'cleo';
import { useCleoEngine } from '../../EngineContext';
import { colorToVec3, vec3ToHex } from '../../../utils/UtilFunctions';
import { newCustomMaterial } from '../../../utils/customMaterials';
import Collapsable from '../../../components/Collapsable';
import TextureInspector from './TextureInspector';
import CustomMaterialEditor from './CustomMaterialEditor';

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
  const [options, setOptions] = useState<{ wireframe: boolean; transparent: boolean; side: 'front' | 'back' | 'double'; castShadow: boolean;}>(
  {
    wireframe: material.config.wireframe ?? false,
    transparent: material.config.transparent ?? false,
    side: material.config.side ?? 'front',
    castShadow: material.config.castShadow ?? false,
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
  }, [options, material])

  const { eventEmitter: eventEmitter } = useCleoEngine();

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

  const colorInput = 'w-[32px] h-[32px] p-0 border border-[#2d2d77] rounded bg-transparent';
  const numberInput = 'bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1 w-[80px]';
  const selectInput = 'bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1';

  return (
    <Collapsable title='Material'>
      <div className='w-full p-2'>
        {/* Shader selector */}
        <div className='mb-2 flex items-center gap-2'>
          <span className='text-xs text-slate-300'>Shader</span>
          <select className={selectInput} value={shaderType} onChange={(e) => handleShaderTypeChange(e.target.value as ShaderType)}>
            <option value='basic'>Basic</option>
            <option value='blinn_phong'>Blinn-Phong</option>
            <option value='pbr'>PBR</option>
            <option value='custom'>Custom (shader)</option>
          </select>
        </div>

        {shaderType === 'custom' && <CustomMaterialEditor node={props.node} />}

        {shaderType === 'blinn_phong' && (
          <>
            <h5 className='m-0 mb-1 font-bold'>Colors</h5>
            <table className='w-full text-left border-collapse'>
              <tbody>
                <tr>
                  <td>Diffuse</td>
                  <td>Specular</td>
                  <td>Shininess</td>
                  <td>Ambient</td>
                  <td>Emission</td>
                </tr>
                <tr>
                  <td>
                    <input type='color' className={colorInput} value={diffuse} onChange={(e) => {
                      model.material.properties.set('diffuse', colorToVec3(e.target.value));
                      setDiffuse(e.target.value); }} 
                    />
                  </td>
                  
                  <td>
                    <input type='color' className={colorInput} value={specular} onChange={(e) => {
                      model.material.properties.set('specular', colorToVec3(e.target.value));
                      setSpecular(e.target.value); }}
                    />
                  </td>
                  <td>
                    <input type='number' className={numberInput} value={shininess} onChange={(e) => {
                      model.material.properties.set('shininess', Number(e.target.value));
                      setShininess(e.target.value); }}
                    />
                  </td>
                  <td>
                    <input type='color' className={colorInput} value={ambient} onChange={(e) => {
                      model.material.properties.set('ambient', colorToVec3(e.target.value));
                      setAmbient(e.target.value); }}
                    />
                  </td>
                  <td>
                    <input type='color' className={colorInput} value={emission} onChange={(e) => {
                      model.material.properties.set('emissive', colorToVec3(e.target.value));
                      setEmission(e.target.value); }}
                    />
                  </td>
                </tr>
              </tbody>
            </table>

            {/* Opacity slider for Default material */}
            <div className='mt-2'>
              <span className='text-xs text-slate-300 mr-2'>Opacity</span>
              <input
                type='range'
                min={0}
                max={1}
                step={0.01}
                value={defaultOpacity}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setDefaultOpacity(v);
                  model.material.properties.set('opacity', v);
                }}
              />
              <span className='text-xs ml-2'>{defaultOpacity.toFixed(2)}</span>
            </div>

            <h5 className='m-0 mt-2 mb-1 font-bold'>Textures</h5>
            <table className='w-full text-left border-collapse'>
              <tbody>
                <tr>
                  <td>Diffuse</td>
                  <td>Specular</td>
                  <td>Normal</td>
                </tr>
                <tr>
                  <td>
                    <TextureInspector tex={'baseTexture'} material={model.material} />
                  </td>
                  <td>
                    <TextureInspector tex={'specularMap'} material={model.material} />
                  </td>
                  <td>
                    <TextureInspector tex={'normalMap'} material={model.material} />
                  </td>
                </tr>
                <tr>
                  <td>Emission</td>
                  <td>Mask</td>
                  <td>Reflectivity</td>
                </tr>
                <tr>
                  <td>
                    <TextureInspector tex={'emissiveMap'} material={model.material} />
                  </td>
                  <td>
                    <TextureInspector tex={'maskMap'} material={model.material} />
                  </td>
                  <td>
                    <TextureInspector tex={'reflectivityMap'} material={model.material} />
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        )}

        {shaderType === 'basic' && (
          <>
            <h5 className='m-0 mb-1 font-bold'>Properties</h5>
            <table className='w-full text-left border-collapse'>
              <tbody>
                <tr>
                  <td>Color</td>
                  <td>Opacity</td>
                </tr>
                <tr>
                  <td>
                    <input
                      type='color'
                      className={colorInput}
                      value={basicColor}
                      onChange={(e) => {
                        model.material.properties.set('color', colorToVec3(e.target.value));
                        setBasicColor(e.target.value);
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type='number'
                      className={numberInput}
                      value={basicOpacity}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        model.material.properties.set('opacity', v);
                        setBasicOpacity(v);
                      }}
                    />
                  </td>
                </tr>
              </tbody>
            </table>

            <h5 className='m-0 mt-2 mb-1 font-bold'>Texture</h5>
            <table className='w-full text-left border-collapse'>
              <tbody>
                <tr>
                  <td>Texture</td>
                </tr>
                <tr>
                  <td>
                    <TextureInspector tex={'texture'} material={model.material} />
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        )}

        {shaderType === 'pbr' && (
          <>
            <h5 className='m-0 mb-1 font-bold'>Properties</h5>
            <table className='w-full text-left border-collapse'>
              <tbody>
                <tr>
                  <td>Base Color</td>
                  <td>Metallic / Roughness</td>
                  <td>Opacity</td>
                  <td>Emissive</td>
                </tr>
                <tr>
                  <td>
                    <input type='color' className={colorInput} value={baseColor} onChange={(e) => {
                      model.material.properties.set('baseColor', colorToVec3(e.target.value));
                      setBaseColor(e.target.value);
                    }} />
                  </td>
                  <td>
                    <div className='flex flex-col gap-1'>
                      <label className='text-xs text-slate-300'>Metallic</label>
                      <div>
                        <input
                          type='range'
                          min={0}
                          max={1}
                          step={0.01}
                          value={metallic}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setMetallic(v);
                            model.material.properties.set('metallic', v);
                          }}
                        />
                        <span className='text-xs ml-2'>{metallic.toFixed(2)}</span>
                      </div>
                      <label className='text-xs text-slate-300 mt-1'>Roughness</label>
                      <div>
                        <input
                          type='range'
                          min={0}
                          max={1}
                          step={0.01}
                          value={roughness}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setRoughness(v);
                            model.material.properties.set('roughness', v);
                          }}
                        />
                        <span className='text-xs ml-2'>{roughness.toFixed(2)}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <input
                      type='range'
                      min={0}
                      max={1}
                      step={0.01}
                      value={pbrOpacity}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setPbrOpacity(v);
                        model.material.properties.set('opacity', v);
                      }}
                    />
                    <span className='text-xs ml-2'>{pbrOpacity.toFixed(2)}</span>
                  </td>
                  <td>
                    <input type='color' className={colorInput} value={emissiveFactor} onChange={(e) => {
                      model.material.properties.set('emissiveFactor', colorToVec3(e.target.value));
                      setEmissiveFactor(e.target.value);
                    }} />
                  </td>
                </tr>
              </tbody>
            </table>

            <h5 className='m-0 mt-2 mb-1 font-bold'>Textures</h5>
            <table className='w-full text-left border-collapse'>
              <tbody>
                <tr>
                  <td>Base Color</td>
                  <td>Metallic+Roughness</td>
                  <td>Normal</td>
                </tr>
                <tr>
                  <td>
                    <TextureInspector tex={'baseColorTexture'} material={model.material} />
                  </td>
                  <td>
                    <TextureInspector tex={'metallicRoughnessTexture'} material={model.material} />
                  </td>
                  <td>
                    <TextureInspector tex={'normalMap'} material={model.material} />
                  </td>
                </tr>
                <tr>
                  <td>Occlusion</td>
                  <td>Emissive</td>
                  <td></td>
                </tr>
                <tr>
                  <td>
                    <TextureInspector tex={'occlusionMap'} material={model.material} />
                  </td>
                  <td>
                    <TextureInspector tex={'emissiveMap'} material={model.material} />
                  </td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </>
        )}

        <h5 className='m-0 mt-2 mb-1 font-bold'>Options</h5>
        {/* Implemented: local state-bound Options */}
        <table className='w-full text-left border-collapse'>
            <tbody>
              <tr>
                  <td>Wireframe</td>
                  <td>Transparent</td>
                  <td>Side</td>
                  <td>Cast Shadow</td>
              </tr>
              <tr>
                <td>
                  <input
                    type='checkbox'
                    checked={options.wireframe}
                    onChange={(e) => setOptions((prev) => ({ ...prev, wireframe: e.target.checked }))}
                  />
                </td>
                <td>
                  <input
                    type='checkbox'
                    checked={options.transparent}
                    onChange={(e) => setOptions((prev) => ({ ...prev, transparent: e.target.checked }))}
                  />
                </td>
                <td>
                  <select
                    className={selectInput}
                    value={options.side}
                    onChange={(e) => setOptions((prev) => ({ ...prev, side: e.target.value as 'front' | 'back' | 'double' }))}
                  > 
                    <option value={'front'}>Front</option>
                    <option value={'back'}>Back</option>
                    <option value={'double'}>Both</option>
                  </select>
                </td>
                <td>
                  <input
                    type='checkbox'
                    checked={options.castShadow}
                    onChange={(e) => setOptions((prev) => ({ ...prev, castShadow: e.target.checked }))}
                  />
                </td>
              </tr>
            </tbody>
        </table>
      </div>
    </Collapsable>
  )
}
