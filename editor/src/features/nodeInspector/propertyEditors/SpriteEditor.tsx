import { useState, useEffect } from 'react';
import { SpriteNode } from 'cleo';
import { colorToVec3, vec3ToHex } from '../../../utils/UtilFunctions';
import Collapsable from '../../../components/Collapsable';
import TextureInspector from './TextureInspector';
import { useCleoEngine } from '../../EngineContext';

export default function SpriteEditor(props: {node: SpriteNode}) {
  const sprite = props.node.sprite;
  const material = sprite.material;

  const { eventEmitter: eventEmitter } = useCleoEngine();
  const [constraints, setConstraints] = useState<'free' | 'spherical' | 'cylindrical'>(props.node.constraints);
  const [color, setColor] = useState(vec3ToHex(material.properties.get('color')));
  const [opacity, setOpacity] = useState(material.properties.get('opacity'));

  useEffect(() => { eventEmitter.emit('TEXTURES_CHANGED') }, [])

  useEffect(() => {
    setConstraints(props.node.constraints);
    setColor(vec3ToHex(material.properties.get('color')));
    setOpacity(material.properties.get('opacity'));
  }, [props.node])

  return (
    <Collapsable title='Sprite'>
      <div className='w-full p-2'>
        <h5 className='m-0 mb-1 font-bold'>Constraints</h5>
        <label className='mr-2' htmlFor='constraints'>Constraints</label>
        <select className='bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1' id='constraints' value={constraints} onChange={(e) => {
          props.node.constraints = e.target.value as 'free' | 'spherical' | 'cylindrical';
          setConstraints(e.target.value as 'free' | 'spherical' | 'cylindrical');
        }}>
          <option value='free'>Free</option>
          <option value='spherical'>Spherical</option>
          <option value='cylindrical'>Cylindrical</option>
        </select>

        <h5 className='m-0 mt-2 mb-1 font-bold'>Color</h5>
        <input type='color' className='w-[32px] h-[32px] p-0 border border-[#2d2d77] rounded bg-transparent' value={color} onChange={(e) => {
          sprite.material.properties.set('color', colorToVec3(e.target.value));
          setColor(e.target.value); }
        } />

        <h5 className='m-0 mt-2 mb-1 font-bold'>Opacity</h5>
        <input type='range' min='0' max='1' step='0.01' className='w-full' value={opacity} onChange={(e) => {
          sprite.material.properties.set('opacity', Number(e.target.value));
          setOpacity(e.target.value); }
        } />

        <h5 className='m-0 mt-2 mb-1 font-bold'>Texture</h5>
        <TextureInspector tex='texture' material={material} />

      </div>
    </Collapsable>
  )
}
