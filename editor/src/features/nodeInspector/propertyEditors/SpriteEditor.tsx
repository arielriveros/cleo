import { useState, useEffect } from 'react';
import { SpriteNode } from 'cleo';
import Collapsable from '../../../components/Collapsable';
import MaterialSlot from './MaterialSlot';
import { useCleoEngine } from '../../EngineContext';
import { Field, Select } from '../../../components/ui';
import { SpriteIcon } from '../sectionIcons';

export default function SpriteEditor(props: {node: SpriteNode}) {
  const { eventEmitter: eventEmitter } = useCleoEngine();
  const [constraints, setConstraints] = useState<'free' | 'spherical' | 'cylindrical'>(props.node.constraints);

  useEffect(() => { eventEmitter.emit('TEXTURES_CHANGED') }, [])

  useEffect(() => {
    setConstraints(props.node.constraints);
  }, [props.node])

  return (
    <>
      <Collapsable title='Sprite' icon={<SpriteIcon />} persistKey='sprite'>
        <div className='w-full p-2'>
          <Field label='Constraints'>
            <Select value={constraints} onChange={(e) => {
              props.node.constraints = e.target.value as 'free' | 'spherical' | 'cylindrical';
              setConstraints(e.target.value as 'free' | 'spherical' | 'cylindrical');
            }}>
              <option value='free'>Free</option>
              <option value='spherical'>Spherical</option>
              <option value='cylindrical'>Cylindrical</option>
            </Select>
          </Field>
        </div>
      </Collapsable>

      {/* Sprites render Basic materials; the material asset contributes its base color/texture. */}
      <MaterialSlot node={props.node} />
    </>
  )
}
