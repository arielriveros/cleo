import { useEffect, useState } from 'react'
import { Texture, TextureManager } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import Collapsable from '../../components/Collapsable'
import './Styles.css'

function TextureItem({ textureName }: { textureName: string }) {
  return (
    <div className='texture-item'> {textureName} </div>
  )
}

export default function TextureExplorer() {
  const { eventEmmiter } = useCleoEngine();

  const [texturesList, setTexturesList] = useState<string[]>([]);

  
  useEffect(() => {
    const handleTexturesChanged = () => {
      const textures: Map<string, Texture> = TextureManager.Instance.textures;
      const textureNames = Array.from(textures.keys());
      setTexturesList(textureNames);
    };
    
    eventEmmiter.on('texturesChanged', handleTexturesChanged);

    return () => {
        eventEmmiter.off("texturesChanged", handleTexturesChanged); // Remove the listener on component unmount
    };

  }, [eventEmmiter]);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      const filesArray = Array.from(files);
      for (const file of filesArray) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const data = e.target?.result;
          const name = file.name;
          if (data) {
            TextureManager.Instance.addTextureFromBase64(data as string, { wrapping: 'repeat' }, name);
            eventEmmiter.emit('texturesChanged');
          }
        }
        reader.readAsDataURL(file);
      }
    }
  }

  return (
    <Collapsable title='Textures'>
      <div className="texture-explorer">
        <div>
          <b>Upload Textures</b>
          <br/>
          <label htmlFor="file-upload" className="custom-file-upload"> Upload Files </label>
          <input id="file-upload" type="file" multiple accept='.png, .jpg, .jpeg, .tga, .bmp' onChange={handleFileUpload} />
        </div>
        {
          texturesList.map((textureName, index) => {
            return <TextureItem key={index} textureName={textureName} />
          })
        }
      </div>
    </Collapsable>
  )
}
