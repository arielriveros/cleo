import { useState, useEffect } from 'react';
import { SpriteNode } from 'cleo';
import Collapsable from '../../../components/Collapsable';
import MaterialSlot from './MaterialSlot';
import { useCleoEngine } from '../../EngineContext';

export default function SpriteEditor(props: {node: SpriteNode}) {
  const { eventEmitter: eventEmitter } = useCleoEngine();
  const [constraints, setConstraints] = useState<'free' | 'spherical' | 'cylindrical'>(props.node.constraints);

  useEffect(() => { eventEmitter.emit('TEXTURES_CHANGED') }, [])

  useEffect(() => {
    setConstraints(props.node.constraints);
  }, [props.node])

  return (
    <>
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
        </div>
      </Collapsable>

      {/* Sprites render Basic materials; the material asset contributes its base color/texture. */}
      <MaterialSlot node={props.node} />
    </>
  )
}
