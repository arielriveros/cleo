import { useState, useEffect } from 'react'
import { LightNode, ModelNode, PointLight, Spotlight } from 'cleo'
import { vec3ToHex } from '../../../utils/UtilFunctions';
import Collapsable from '../../../components/Collapsable'
import './Styles.css'


interface ColorInputProps {
  color: string | number | readonly string[] | undefined;
  onChange: (value: [number, number, number]) => void;
}
export function ColorInput(props: ColorInputProps) {

  const colorToVec3 = (color: string) => {
    return color.match(/[A-Za-z0-9]{2}/g)!.map(function(v) { return parseInt(v, 16) / 255});
  };

  return (
    <input type='color' className='materialInput' value={props.color} onChange={(e) => {
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
    const debugModel = props.node.getChildByName('__debug__LightModel');
    if (debugModel[0])
      (debugModel[0] as ModelNode).model.material.properties.set('color', light.diffuse);
  }, [props.node, diffuse])

  return (
    <Collapsable title='Light'>
    <div className='material-editor'>
      <table>
        <colgroup>
          <col span={1} style={{width: '16%'}} />
          <col span={1} style={{width: '28%'}} />
          <col span={1} style={{width: '28%'}} />
          <col span={1} style={{width: '28%'}} />
        </colgroup>
        <thead>
          <tr>
            <th></th>
            <th>Diffuse</th>
            <th>Specular</th>
            <th>Ambient</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td> Colors </td>
            <td>
              <ColorInput color={diffuse} onChange={(color) => { 
                light.diffuse = color;
                setDiffuse(vec3ToHex(color));
              }} />
            </td>
            
            <td>
              <ColorInput color={specular} onChange={(color) => { 
                light.specular = color;
                setSpecular(vec3ToHex(color));
              }} />
            </td>
            <td>
              <ColorInput color={ambient} onChange={(color) => { 
                light.ambient = color;
                setAmbient(vec3ToHex(color));
              }} />
            </td>
          </tr>
        </tbody>
      </table>

      { props.node.light instanceof PointLight &&
        <div>
          <h3>Point Light</h3>
          <div>
            {/* TODO, light properties should be managed as a state, not directly */}
            <label>Constant: {properties.constant}</label>
            <input type='range' className='materialInput' value={properties.constant} min='0' max='1' step='0.01' onChange={(e) => {
              setProperties({...properties, constant: parseFloat(e.target.value)});
            }} />
            

            <label>Linear: {properties.linear}</label>
            <input type='range' className='materialInput' value={properties.linear} min='0' max='1' step='0.01' onChange={(e) => {
              setProperties({...properties, linear: parseFloat(e.target.value)});
            }} />

            <label>Quadratic: {properties.quadratic}</label>
            <input type='range' className='materialInput' value={properties.quadratic} min='0' max='1' step='0.01' onChange={(e) => {
              setProperties({...properties, quadratic: parseFloat(e.target.value)});
            }} />
          </div>
        </div>
      }
      { props.node.light instanceof Spotlight &&
        <div>
          <h3>Spot Light</h3>
          <div>
            {/* TODO, light properties should be managed as a state, not directly */}
            <label>Constant: {properties.constant}</label>
            <input type='range' className='materialInput' value={properties.constant} min='0' max='1' step='0.1' onChange={(e) => {
              setProperties({...properties, constant: parseFloat(e.target.value)});
            }} />

            <label>Linear: {properties.linear}</label>
            <input type='range' className='materialInput' value={properties.linear} min='0' max='1' step='0.01' onChange={(e) => {
              setProperties({...properties, linear: parseFloat(e.target.value)});
            }} />

            <label>Quadratic: {properties.quadratic}</label>
            <input type='range' className='materialInput' value={properties.quadratic} min='0' max='1' step='0.001' onChange={(e) => {
              setProperties({...properties, quadratic: parseFloat(e.target.value)});
            }} />

            <label>Cut Off: {properties.cutOff?.toFixed(2)}</label>
            <input type='range' className='materialInput' value={properties.cutOff} min='0' max='60' step='0.01' onChange={(e) => {
              setProperties({...properties, cutOff: parseFloat(e.target.value)});
            }} />

            <label>Outer Cut Off: {properties.outerCutOff?.toFixed(2)}</label>
            <input type='range' className='materialInput' value={properties.outerCutOff} min='0' max='60' step='0.01' onChange={(e) => {
              setProperties({...properties, outerCutOff: parseFloat(e.target.value)});
            }} />
          </div>
        </div>
      }
    </div>
    </Collapsable>
  )
}
