import { useState, useEffect } from 'react';
import { ModelNode } from 'cleo';
import { useCleoEngine } from '../../EngineContext';
import { colorToVec3, vec3ToHex } from '../../../utils/UtilFunctions';
import Collapsable from '../../../components/Collapsable';
import TextureInspector from './TextureInspector';

export default function MaterialEditor(props: {node: ModelNode}) {
  // Safety check to ensure the node has a model
  if (!props.node.model) {
    return <div>No model available for this node.</div>;
  }
  
  const model = props.node.model;
  const material = model.material;

  const [diffuse, setDiffuse] = useState(vec3ToHex(material.properties.get('diffuse')));
  const [specular, setSpecular] = useState(vec3ToHex(material.properties.get('specular')));
  const [ambient, setAmbient] = useState(vec3ToHex(material.properties.get('ambient')));
  const [shininess, setShininess] = useState(material.properties.get('shininess') || 32);
  const [emission, setEmission] = useState(vec3ToHex(material.properties.get('emissive')));
  // NEW: Local UI state for options
  const [options, setOptions] = useState<{ wireframe: boolean; transparent: boolean; side: 'front' | 'back' | 'double'; castShadow: boolean;}>({
    wireframe: material.config.wireframe ?? false,
    transparent: material.config.transparent ?? false,
    side: material.config.side ?? 'front',
    castShadow: material.config.castShadow ?? false,
  });

  useEffect(() => {
    setDiffuse(vec3ToHex(material.properties.get('diffuse')));
    setSpecular(vec3ToHex(material.properties.get('specular')));
    setAmbient(vec3ToHex(material.properties.get('ambient')));
    setShininess(material.properties.get('shininess') || 32);
    setEmission(vec3ToHex(material.properties.get('emissive')));
    // Sync options UI from material when node changes
    setOptions({
      wireframe: material.config.wireframe ?? false,
      transparent: material.config.transparent ?? false,
      side: material.config.side ?? 'front',
      castShadow: material.config.castShadow ?? false,
    });

  }, [props.node])

  // Apply options changes back to the material config
  useEffect(() => {
    material.config.wireframe = options.wireframe;
    material.config.transparent = options.transparent;
    material.config.side = options.side;
    material.config.castShadow = options.castShadow;
  }, [options, material])

  const { eventEmitter: eventEmitter } = useCleoEngine();

  useEffect(() => { eventEmitter.emit('TEXTURES_CHANGED') }, [])

  const colorInput = 'w-[32px] h-[32px] p-0 border border-[#2d2d77] rounded bg-transparent';
  const numberInput = 'bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1 w-[80px]';
  const selectInput = 'bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1';

  return (
    <Collapsable title='Material'>
      <div className='w-full p-2'>
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
