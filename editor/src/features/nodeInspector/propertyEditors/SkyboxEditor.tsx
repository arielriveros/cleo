import { useState, useEffect } from 'react'
import { Texture, Skybox, SkyboxNode } from 'cleo'
import { CubemapFaces } from 'cleo/graphics/texture';
import Collapsable from '../../../components/Collapsable'
import { SkyboxIcon } from '../sectionIcons'
import { useCleoEngine } from '../../EngineContext';

function FaceEditor(props: { faceName: 'posX' | 'negX' | 'posY' | 'negY' | 'posZ' | 'negZ', texture: Texture }) {
    const { eventEmitter } = useCleoEngine();
    const [img, setImg] = useState<HTMLImageElement | null>(null);

    useEffect(() => {
        switch(props.faceName) {
            case 'posX': setImg((props.texture.data as CubemapFaces).posX); break;
            case 'negX': setImg((props.texture.data as CubemapFaces).negX); break;
            case 'posY': setImg((props.texture.data as CubemapFaces).posY); break;
            case 'negY': setImg((props.texture.data as CubemapFaces).negY); break;
            case 'posZ': setImg((props.texture.data as CubemapFaces).posZ); break;
            case 'negZ': setImg((props.texture.data as CubemapFaces).negZ); break;
        }
    }, [props.faceName]);


    return (
        <div className='flex flex-col items-center gap-2 p-2 border border-border rounded bg-surface-raised'>
            {img && <img className='max-h-28 object-cover rounded' src={img.src} />}
            <label htmlFor={`${props.faceName}-upload`} className="px-2 py-1 rounded border border-border bg-control hover:bg-control-hover cursor-pointer">
                Upload
            </label>
            <input id={`${props.faceName}-upload`} className='hidden' type='file' onChange={(e) => {
                const file = e.target.files?.item(0);
                if (file && file.type.startsWith('image')) {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const data = e.target?.result;
                        const img = new Image();
                        img.src = data as string;
                        img.onload = () => {
                            setImg(img);
                            props.texture.updateFace(props.faceName, img)
                            eventEmitter.emit('SCENE_CHANGED', { kind: 'texture' })
                        }
                    }
                    reader.readAsDataURL(file);
                }
            }} />
        </div>
    )
}

function CubemapInspector(props: { skybox: Skybox }) {

    return (
        <div className='overflow-x-auto'> {
            props.skybox.texture && 
            <table className='mx-auto'>
                <tbody>
                    <tr>
                        <td></td>
                        <td></td>
                        <td>
                            <FaceEditor faceName='posY' texture={props.skybox.texture} />
                        </td>
                        <td></td>
                    </tr>
                    <tr>
                        <td>
                            <FaceEditor faceName='negZ' texture={props.skybox.texture} />
                        </td>
                        <td>
                            <FaceEditor faceName='negX' texture={props.skybox.texture} />
                        </td>
                        <td>
                            <FaceEditor faceName='posZ' texture={props.skybox.texture} />
                        </td>
                        <td>
                            <FaceEditor faceName='posX' texture={props.skybox.texture} />
                        </td>
                    </tr>
                    <tr>
                        <td></td>
                        <td></td>
                        <td>
                            <FaceEditor faceName='negY' texture={props.skybox.texture} />
                        </td>
                        <td></td>
                    </tr>
                </tbody>
            </table>
        } </div>
    )
}

export default function SkyboxEditor(props: {node: SkyboxNode}) {
  return (
    <Collapsable title='Skybox' icon={<SkyboxIcon />} persistKey='skybox'>
        <div className='p-2'>
          <CubemapInspector skybox={props.node.skybox} />
        </div>
    </Collapsable>
  )
}
