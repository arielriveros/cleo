import React, { useEffect, useState } from 'react'
import { TextureManager, Material } from 'cleo';
import { useCleoEngine } from '../../EngineContext';
import ImportIcon from '../../../icons/import.png';
import NullImage from '../../../images/null.png';

export default function TextureInspector(props: { tex: string, material: Material }) {
  const { eventEmitter: eventEmitter } = useCleoEngine();
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
        eventEmitter.emit("TEXTURES_CHANGED");
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
    props.material.properties.set(`has${props.tex.charAt(0).toUpperCase() + props.tex.slice(1)}`, true)

    setTexture(textureId);
  }

  useEffect(() => {
    const handleTexturesChanged = () => {
      setTexturesIds(Array.from(TextureManager.Instance.textures.keys()).filter(key => !(key.includes('__editor__') || key.includes('__debug__'))));
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
    eventEmitter.on("TEXTURES_CHANGED", handleTexturesChanged);
    return () => {
      eventEmitter.off("TEXTURES_CHANGED", handleTexturesChanged);
    }
  }, [eventEmitter, textureMissing, texture]);

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