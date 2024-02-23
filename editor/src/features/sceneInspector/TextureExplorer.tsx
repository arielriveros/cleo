import { useEffect, useState } from 'react'
import { Texture, TextureManager } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import Collapsable from '../../components/Collapsable'
import './TextureExplorer.css'

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

  return (
    <Collapsable title='Textures'>
      <div className="texture-explorer">
        {
          texturesList.map((textureName, index) => {
            return <TextureItem key={index} textureName={textureName} />
          })
        }
      </div>
    </Collapsable>
  )
}
