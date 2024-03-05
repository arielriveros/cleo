import { useState, useEffect } from 'react';
import { SpriteNode } from 'cleo';
import { colorToVec3, vec3ToHex } from '../../../utils/UtilFunctions';
import Collapsable from '../../../components/Collapsable';
import TextureInspector from './TextureInspector';
import './Styles.css';
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
      <div className='materialEditor'>
        <h5>Constraints</h5>
        <label htmlFor='constraints'>Constraints</label>
        <select id='constraints' value={constraints} onChange={(e) => {
          props.node.constraints = e.target.value as 'free' | 'spherical' | 'cylindrical';
          setConstraints(e.target.value as 'free' | 'spherical' | 'cylindrical');
        }}>
          <option value='free'>Free</option>
          <option value='spherical'>Spherical</option>
          <option value='cylindrical'>Cylindrical</option>
        </select>

        <h5>Color</h5>
        <input type='color' className='material-input' value={color} onChange={(e) => {
          sprite.material.properties.set('color', colorToVec3(e.target.value));
          setColor(e.target.value); }
        } />

        <h5>Opacity</h5>
        <input type='range' min='0' max='1' step='0.01' className='material-input' value={opacity} onChange={(e) => {
          sprite.material.properties.set('opacity', Number(e.target.value));
          setOpacity(e.target.value); }
        } />

        <h5>Texture</h5>
        <TextureInspector tex='texture' material={material} />

      </div>
    </Collapsable>
  )
}
