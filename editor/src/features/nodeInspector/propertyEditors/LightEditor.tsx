import { useState, useEffect } from 'react'
import { LightNode, ModelNode, PointLight, Spotlight, Vec } from 'cleo'
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

  const compToHex = (c: number) => {
    var hex = c.toString(16);
    return hex.length == 1 ? "0" + hex : hex;
  };

  const vec3ToHex = (vec: Vec.vec3) => {
    return "#" + compToHex(Math.round(vec[0] * 255)) + compToHex(Math.round(vec[1] * 255)) + compToHex(Math.round(vec[2] * 255));
  };

  const light = props.node.light;

  const [diffuse, setDiffuse] = useState(vec3ToHex(light.diffuse));
  const [specular, setSpecular] = useState(vec3ToHex(light.specular));
  const [ambient, setAmbient] = useState(vec3ToHex(light.ambient));

  useEffect(() => {
    setDiffuse(vec3ToHex(light.diffuse));
    setSpecular(vec3ToHex(light.specular));
    setAmbient(vec3ToHex(light.ambient));
  }, [props.node])

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
            <label>Constant</label>
            <input type='range' className='materialInput' value={props.node.light.constant} min='0' max='1' step='0.01' onChange={(e) => {
              (props.node.light as PointLight).constant = parseFloat(e.target.value);
            }} />

            <label>Linear</label>
            <input type='range' className='materialInput' value={props.node.light.linear} min='0' max='1' step='0.01' onChange={(e) => {
              (props.node.light as PointLight).linear = parseFloat(e.target.value);
            }} />

            <label>Quadratic</label>
            <input type='range' className='materialInput' value={props.node.light.quadratic} min='0' max='1' step='0.01' onChange={(e) => {
              (props.node.light as PointLight).quadratic = parseFloat(e.target.value);
            }} />
          </div>
        </div>
      }
      { props.node.light instanceof Spotlight &&
        <div>
          <h3>Spot Light</h3>
          <div>
            {/* TODO, light properties should be managed as a state, not directly */}
            <label>Constant</label>
            <input type='range' className='materialInput' value={props.node.light.constant} min='0' max='1' step='0.01' onChange={(e) => {
              (props.node.light as Spotlight).constant = parseFloat(e.target.value);
            }} />

            <label>Linear</label>
            <input type='range' className='materialInput' value={props.node.light.linear} min='0' max='1' step='0.01' onChange={(e) => {
              (props.node.light as Spotlight).linear = parseFloat(e.target.value);
            }} />

            <label>Quadratic</label>
            <input type='range' className='materialInput' value={props.node.light.quadratic} min='0' max='1' step='0.01' onChange={(e) => {
              (props.node.light as Spotlight).quadratic = parseFloat(e.target.value);
            }} />

            <label>Cut Off</label>
            <input type='range' className='materialInput' value={props.node.light.cutOff} min='0' max='180' step='0.01' onChange={(e) => {
              (props.node.light as Spotlight).cutOff = parseFloat(e.target.value);
            }} />

            <label>Outer Cut Off</label>
            <input type='range' className='materialInput' value={props.node.light.outerCutOff} min='0' max='180' step='0.01' onChange={(e) => {
              (props.node.light as Spotlight).outerCutOff = parseFloat(e.target.value);
            }} />
          
          </div>
        </div>
      }
    </div>
    </Collapsable>
  )
}
