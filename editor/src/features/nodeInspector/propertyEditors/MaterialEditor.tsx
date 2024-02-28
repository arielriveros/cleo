import { useState, useEffect } from 'react';
import { ModelNode, TextureManager, Material } from 'cleo';
import { useCleoEngine } from '../../EngineContext';
import { colorToVec3, vec3ToHex } from '../../../utils/UtilFunctions';
import ImportIcon from '../../../icons/import.png';
import Collapsable from '../../../components/Collapsable';
import NullImage from '../../../images/null.png';
import './Styles.css';

function TextureInspector(props: { tex: string, material: Material }) {
  const { eventEmmiter } = useCleoEngine();
  const [texture, setTexture] = useState<string | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [texturesIds, setTexturesIds] = useState<string[]>([]);
  const [textureMissing, setTextureMissing] = useState(false);

  useEffect(() => {
    const texId = props.material.textures.get(props.tex);
    setTexture(texId ? texId : null);
  }, [props.material, props.tex])

  useEffect(() => {
    if (texture) {
      const tex = TextureManager.Instance.getTexture(texture);
      if (tex) {
        setImg(tex.data as HTMLImageElement);
        setTextureMissing(false);
      }
      else {
        // Missing texture from the texture manager
        const img = new Image();
        img.src = NullImage;
        setImg(img);
        setTextureMissing(true);
      }
    }
    else setImg(null)
  }, [texture])

  const deleteTexture = () => {
      props.material.textures.delete(props.tex);
      if (props.tex === 'baseTexture')
        props.material.properties.set('hasBaseTexture', false)
      else
        props.material.properties.set(`has${props.tex.charAt(0).toUpperCase() + props.tex.slice(1)}`, false)

      setTexture(null);
  }

  const onTextureUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.item(0);
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const data = e.target?.result;
            const img = new Image();
            img.src = data as string;
            img.onload = () => {
              let texName = file.name;
              // if texture exists, change the name
              let i = 1;
              while (TextureManager.Instance.getTexture(texName)) {
                texName = `${file.name.split('.')[0]}_${i}.${file.name.split('.')[1]}`;
                i++;
              }

              TextureManager.Instance.addTextureFromData(img, { wrapping: 'repeat' }, texName);
              onTextureSelect(texName);
              eventEmmiter.emit("TEXTURES_CHANGED");
            }
          }
        reader.readAsDataURL(file);
      }
  }

  const onTextureSelect = (textureId: string) => {
      if (textureId === 'None') {
          deleteTexture();
          return;
      }

      props.material.textures.set(props.tex, textureId);
      if (props.tex === 'baseTexture')
          props.material.properties.set('hasBaseTexture', true)
      else {
          props.material.properties.set(`has${props.tex.charAt(0).toUpperCase() + props.tex.slice(1)}`, true)
      }
      setTexture(textureId);
  }

  useEffect(() => { eventEmmiter.emit('TEXTURES_CHANGED') }, [])

  useEffect(() => {
      const handleTexturesChanged = () => {
          setTexturesIds(Array.from(TextureManager.Instance.textures.keys()));
          if (textureMissing) {
              // check if missing texture is now available
              if (texture && TextureManager.Instance.getTexture(texture)) {
                  setTextureMissing(false);
                  // add a little delay to avoid the texture not being available
                  setTimeout(() => setImg(TextureManager.Instance.getTexture(texture).data as HTMLImageElement), 300);
                  setImg(TextureManager.Instance.getTexture(texture).data as HTMLImageElement);
              }
          }
      }
      eventEmmiter.on("TEXTURES_CHANGED", handleTexturesChanged);
      return () => {
          eventEmmiter.off("TEXTURES_CHANGED", handleTexturesChanged);
      }
  }, [eventEmmiter, textureMissing, texture]);

  return (
    <div className='texture-inspector'>
      {img && <img className='tex-image' src={img.src} />}
      <button className='texture-delete' onClick={() => deleteTexture()}> ✕ </button>
        <select 
          className='texture-select'
          name="textures"
          id="textures"
          onChange={e => onTextureSelect(e.target.value)}
          value={texture ? texture : 'None'}
        >
          <option value='None' >None</option>
          {
            texturesIds.map((key, i) => {
              return <option key={i} value={key}>{key}</option>
            })
          }
        </select>
      
      <label htmlFor={`${props.tex}-upload`} className="texture-upload" title="Upload an image as texture">
          <img src={ImportIcon} alt="upload" width='20' height='20' />
      </label>
      <input id={`${props.tex}-upload`} type='file' onChange={ e => onTextureUpload(e)} />
      {
        textureMissing && texture && <div className='texture-missing' title={texture}>
          <span> Missing </span>
          <span> {texture} </span>
        </div>
      }
    </div>
  )
}

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
