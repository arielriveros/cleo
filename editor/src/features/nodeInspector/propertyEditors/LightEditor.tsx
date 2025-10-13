import { useState, useEffect } from 'react'
import { LightNode, ModelNode, PointLight, Spotlight, SpriteNode } from 'cleo'
import { vec3ToHex } from '../../../utils/UtilFunctions';
import Collapsable from '../../../components/Collapsable'


interface ColorInputProps {
  color: string | number | readonly string[] | undefined;
  onChange: (value: [number, number, number]) => void;
}
export function ColorInput(props: ColorInputProps) {

  const colorToVec3 = (color: string) => {
    return color.match(/[A-Za-z0-9]{2}/g)!.map(function(v) { return parseInt(v, 16) / 255});
  };

  return (
    <input
      type='color'
      className='h-8 w-10 p-0 border border-[#2d2d77] rounded bg-[#3b3b3b]'
      value={props.color}
      onChange={(e) => {
        let color = colorToVec3(e.target.value);
        props.onChange([color[0], color[1], color[2]]);
      }}
    />
  )
};

export default function LightEditor(props: {node: LightNode}) {
  const light = props.node.light;

  const [diffuse, setDiffuse] = useState(vec3ToHex(light.diffuse));
  const [specular, setSpecular] = useState(vec3ToHex(light.specular));
  const [ambient, setAmbient] = useState(vec3ToHex(light.ambient));
  const [properties, setProperties] = useState<{constant?: number, linear?: number, quadratic?: number, cutOff?: number, outerCutOff?: number}>({
    constant: 0,
    linear: 0,
    quadratic: 0,
    cutOff: 0,
    outerCutOff: 0
  });

  useEffect(() => {
    setDiffuse(vec3ToHex(light.diffuse));
    setSpecular(vec3ToHex(light.specular));
    setAmbient(vec3ToHex(light.ambient));

    if (props.node.light instanceof PointLight) {
      setProperties({
        constant: (props.node.light as PointLight).constant,
        linear: (props.node.light as PointLight).linear,
        quadratic: (props.node.light as PointLight).quadratic
      });
    }

    if (props.node.light instanceof Spotlight) {
      setProperties({
        constant: (props.node.light as Spotlight).constant,
        linear: (props.node.light as Spotlight).linear,
        quadratic: (props.node.light as Spotlight).quadratic,
        cutOff: (props.node.light as Spotlight).cutOff,
        outerCutOff: (props.node.light as Spotlight).outerCutOff
      });
    }

  }, [props.node])

  useEffect(() => {
    if (props.node.light instanceof PointLight) {
      (props.node.light as PointLight).constant = properties.constant!;
      (props.node.light as PointLight).linear = properties.linear!;
      (props.node.light as PointLight).quadratic = properties.quadratic!;
    }
    if (props.node.light instanceof Spotlight) {
      (props.node.light as Spotlight).constant = properties.constant!;
      (props.node.light as Spotlight).linear = properties.linear!;
      (props.node.light as Spotlight).quadratic = properties.quadratic!;
      if (properties.cutOff! > properties.outerCutOff!) {
        // Outer cut off should be greater than cut off
        setProperties({...properties, outerCutOff: properties.cutOff! + 0.01});
        return;
      }
      (props.node.light as Spotlight).cutOff = properties.cutOff!;
      (props.node.light as Spotlight).outerCutOff = properties.outerCutOff!;
    }
  }, [properties])

  useEffect(() => {
    const editorSprite = props.node.getChildByName('__editor__LightSprite');
    if (editorSprite[0])
      (editorSprite[0] as SpriteNode).sprite.material.properties.set('color', light.diffuse);
  }, [props.node, diffuse])

  const slider = 'w-[220px] align-middle ml-2';

  return (
    <Collapsable title='Light'>
    <div className='w-full p-2'>
      <table className='w-full border-collapse'>
        <colgroup>
          <col span={1} style={{width: '16%'}} />
          <col span={1} style={{width: '28%'}} />
          <col span={1} style={{width: '28%'}} />
          <col span={1} style={{width: '28%'}} />
        </colgroup>
        <thead>
          <tr>
            <th className='text-left px-2 py-1'></th>
            <th className='text-left px-2 py-1'>Diffuse</th>
            <th className='text-left px-2 py-1'>Specular</th>
            <th className='text-left px-2 py-1'>Ambient</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className='px-2 py-1'> Colors </td>
            <td className='px-2 py-1'>
              <ColorInput color={diffuse} onChange={(color) => { 
                light.diffuse = color;
                setDiffuse(vec3ToHex(color));
              }} />
            </td>
            
            <td className='px-2 py-1'>
              <ColorInput color={specular} onChange={(color) => { 
                light.specular = color;
                setSpecular(vec3ToHex(color));
              }} />
            </td>
            <td className='px-2 py-1'>
              <ColorInput color={ambient} onChange={(color) => { 
                light.ambient = color;
                setAmbient(vec3ToHex(color));
              }} />
            </td>
          </tr>
        </tbody>
      </table>

      { props.node.light instanceof PointLight &&
        <div className='mt-3'>
          <h3 className='font-semibold mb-2'>Point Light</h3>
          <div className='flex flex-col gap-2'>
            {/* TODO, light properties should be managed as a state, not directly */}
            <label>Constant: {properties.constant}</label>
            <input type='range' className={slider} value={properties.constant} min='0' max='1' step='0.01' onChange={(e) => {
              setProperties({...properties, constant: parseFloat(e.target.value)});
            }} />
            

            <label>Linear: {properties.linear}</label>
            <input type='range' className={slider} value={properties.linear} min='0' max='1' step='0.01' onChange={(e) => {
              setProperties({...properties, linear: parseFloat(e.target.value)});
            }} />

            <label>Quadratic: {properties.quadratic}</label>
            <input type='range' className={slider} value={properties.quadratic} min='0' max='1' step='0.01' onChange={(e) => {
              setProperties({...properties, quadratic: parseFloat(e.target.value)});
            }} />
          </div>
        </div>
      }
      { props.node.light instanceof Spotlight &&
        <div className='mt-3'>
          <h3 className='font-semibold mb-2'>Spot Light</h3>
          <div className='flex flex-col gap-2'>
            {/* TODO, light properties should be managed as a state, not directly */}
            <label>Constant: {properties.constant}</label>
            <input type='range' className={slider} value={properties.constant} min='0' max='1' step='0.1' onChange={(e) => {
              setProperties({...properties, constant: parseFloat(e.target.value)});
            }} />

            <label>Linear: {properties.linear}</label>
            <input type='range' className={slider} value={properties.linear} min='0' max='1' step='0.01' onChange={(e) => {
              setProperties({...properties, linear: parseFloat(e.target.value)});
            }} />

            <label>Quadratic: {properties.quadratic}</label>
            <input type='range' className={slider} value={properties.quadratic} min='0' max='1' step='0.001' onChange={(e) => {
              setProperties({...properties, quadratic: parseFloat(e.target.value)});
            }} />

            <label>Cut Off: {properties.cutOff?.toFixed(2)}</label>
            <input type='range' className={slider} value={properties.cutOff} min='0' max='60' step='0.01' onChange={(e) => {
              setProperties({...properties, cutOff: parseFloat(e.target.value)});
            }} />

            <label>Outer Cut Off: {properties.outerCutOff?.toFixed(2)}</label>
            <input type='range' className={slider} value={properties.outerCutOff} min='0' max='60' step='0.01' onChange={(e) => {
              setProperties({...properties, outerCutOff: parseFloat(e.target.value)});
            }} />
          </div>
        </div>
      }
    </div>
    </Collapsable>
  )
}
