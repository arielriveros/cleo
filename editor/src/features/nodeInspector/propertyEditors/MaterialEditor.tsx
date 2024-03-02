import { useState, useEffect } from 'react';
import { ModelNode } from 'cleo';
import { useCleoEngine } from '../../EngineContext';
import { colorToVec3, vec3ToHex } from '../../../utils/UtilFunctions';
import Collapsable from '../../../components/Collapsable';
import TextureInspector from './TextureInspector';
import './Styles.css';

export default function MaterialEditor(props: {node: ModelNode}) {
  const model = props.node.model;
  const material = model.material;

  const [diffuse, setDiffuse] = useState(vec3ToHex(material.properties.get('diffuse')));
  const [specular, setSpecular] = useState(vec3ToHex(material.properties.get('specular')));
  const [ambient, setAmbient] = useState(vec3ToHex(material.properties.get('ambient')));
  const [shininess, setShininess] = useState(material.properties.get('shininess'));
  const [emission, setEmission] = useState(vec3ToHex(material.properties.get('emissive')));

  useEffect(() => {
    setDiffuse(vec3ToHex(material.properties.get('diffuse')));
    setSpecular(vec3ToHex(material.properties.get('specular')));
    setAmbient(vec3ToHex(material.properties.get('ambient')));
    setShininess(material.properties.get('shininess'));
    setEmission(vec3ToHex(material.properties.get('emissive')));

  }, [props.node])

  const { eventEmmiter } = useCleoEngine();

  useEffect(() => { eventEmmiter.emit('TEXTURES_CHANGED') }, [])

  return (
    <Collapsable title='Material'>
      <div className='materialEditor'>
      <h5>Colors</h5>
      <table>
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
              <input type='color' className='material-input' value={diffuse} onChange={(e) => {
                model.material.properties.set('diffuse', colorToVec3(e.target.value));
                setDiffuse(e.target.value); }} 
              />
            </td>
            
            <td>
              <input type='color' className='material-input' value={specular} onChange={(e) => {
                model.material.properties.set('specular', colorToVec3(e.target.value));
                setSpecular(e.target.value); }}
              />
            </td>
            <td>
              <input type='number' className='material-input' value={shininess} onChange={(e) => {
                model.material.properties.set('shininess', Number(e.target.value));
                setShininess(e.target.value); }}
              />
            </td>
            <td>
              <input type='color' className='material-input' value={ambient} onChange={(e) => {
                model.material.properties.set('ambient', colorToVec3(e.target.value));
                setAmbient(e.target.value); }}
              />
            </td>
            <td>
              <input type='color' className='material-input' value={emission} onChange={(e) => {
                model.material.properties.set('emissive', colorToVec3(e.target.value));
                setEmission(e.target.value); }}
              />
            </td>
          </tr>
        </tbody>
      </table>
      <h5>Textures</h5>
      <table>
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
      <h5>Options</h5>
      {/* TODO: UseState for Options */}
      <table>
          <tbody>
            <tr>
                <td>Wireframe</td>
                <td>Transparent</td>
                <td>Side</td>
                <td>Cast Shadow</td>
            </tr>
            <tr>
              <td>
                <input type='checkbox' checked={model.material.config.wireframe} onChange={(e) => {
                  model.material.config.wireframe = !model.material.config.wireframe;
                }} />
              </td>
              <td>
                <input type='checkbox' checked={model.material.config.transparent} onChange={(e) => {
                  model.material.config.transparent = !model.material.config.transparent;
                }} />
              </td>
              <td>
                <select value={model.material.config.side} onChange={(e) => {
                  model.material.config.side = e.target.value as 'front' | 'back' | 'double'; }} > 
                  <option value={'front'}>Front</option>
                  <option value={'back'}>Back</option>
                  <option value={'double'}>Both</option>
                </select>
              </td>
              <td>
                <input type='checkbox' checked={model.material.config.castShadow} onChange={(e) => {
                  model.material.config.castShadow = !model.material.config.castShadow;
                }} />
              </td>
            </tr>
          </tbody>
      </table>
      </div>
    </Collapsable>
  )
}
