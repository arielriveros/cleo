import { useEffect, useState } from 'react'
import { Texture, TextureManager } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import Collapsable from '../../components/Collapsable'

function TextureItem({ textureName }: { textureName: string }) {
  return (
    <div className='flex w-[90%] h-[20px] py-[1px] px-[5px] mb-[1px] border border-[#3b3b3b] rounded-[2px] text-ellipsis overflow-hidden whitespace-nowrap justify-between'> {textureName} </div>
  )
}

export default function TextureExplorer() {
  const { eventEmitter: eventEmitter } = useCleoEngine();

  const [texturesList, setTexturesList] = useState<string[]>([]);

  
  useEffect(() => {
    const handleTexturesChanged = () => {
      const textures: Map<string, Texture> = TextureManager.Instance.textures;
      const textureNames = Array.from(textures.keys()).filter(key => !(key.includes('__editor__') || key.includes('__debug__')))
      setTexturesList(textureNames);
    };
    
    eventEmitter.on('TEXTURES_CHANGED', handleTexturesChanged);

    return () => {
        eventEmitter.off('TEXTURES_CHANGED', handleTexturesChanged); // Remove the listener on component unmount
    };

  }, [eventEmitter]);

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
            eventEmitter.emit('TEXTURES_CHANGED');
          }
        }
        reader.readAsDataURL(file);
      }
    }
  }

  return (
    <Collapsable title='Textures'>
      <div className='flex flex-col w-full h-full pl-[10px]'>
        <div>
          <b>Upload Textures</b>
          <br/>
          <label htmlFor='file-upload' className='bg-[#3b3b3b] text-white border border-black m-[1px] px-2 py-1 rounded cursor-pointer'> Upload Files </label>
          <input id='file-upload' className='hidden' type='file' multiple accept='.png, .jpg, .jpeg, .tga, .bmp' onChange={handleFileUpload} />
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
