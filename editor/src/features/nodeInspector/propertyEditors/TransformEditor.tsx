import { useEffect, useState } from 'react';
import { Node } from 'cleo';
import Collapsable from '../../../components/Collapsable';
import './TransformEditor.css';

interface AxisInputProps {
  node: Node;
  axis: 'x' | 'y' | 'z';
  step: number;
  min?: number;
  max?: number;
  value: number;
  onChange: (value: number) => void;
}
function AxisInput(props: AxisInputProps) {
  return (
    <input 
      type={props.min && props.max ? 'range' :'number'}
      className={`${props.min && props.max ? 'rangeInput' : 'numberInput'} ${props.axis}_axis`}
      step={props.step}
      min={props.min}
      max={props.max}
      value={props.value}
      onChange={(e) => {
        props.onChange(Number(e.target.value))
      }} 
    />
  )
}

export default function TransformEditor(props: {node: Node}) {

  const [position, setPosition] = useState(props.node.position);
  const [rotation, setRotation] = useState(props.node.rotation);
  const [scale, setScale] = useState(props.node.scale);

  useEffect(() => {
      setPosition(props.node.position);
      setRotation(props.node.rotation);
      setScale(props.node.scale);
  }, [props.node]);

  useEffect(() => {
    props.node.setPosition(position);
    props.node.setRotation(rotation);
    props.node.setScale(scale);

  }, [position, rotation, scale]);

  return (
    <Collapsable title='Transform'>
      <div className='transformContainer'>
        <div className='axisEditorContainer'>
          <div className='axisEditor'>
            <div className='label'>Position</div>
            <AxisInput node={props.node} axis='x' step={0.01} value={position[0]} onChange={ value => setPosition([value, position[1], position[2]]) } />
            <AxisInput node={props.node} axis='y' step={0.01} value={position[1]} onChange={ value => setPosition([position[0], value, position[2]]) } />
            <AxisInput node={props.node} axis='z' step={0.01} value={position[2]} onChange={ value => setPosition([position[0], position[1], value]) } />
          </div>
        </div>
        <div className='axisEditorContainer'>
          <div className='axisEditor'>
            <div className='label'>Rotation</div>
              <div className='rotation'>
                <AxisInput node={props.node} axis='x' step={0.05} min={-180} max={180} value={rotation[0]} onChange={value => setRotation([value, rotation[1], rotation[2]]) } />
                <AxisInput node={props.node} axis='x' step={1} value={rotation[0]} onChange={(value) => { setRotation([value, rotation[1], rotation[2]]); }} />
              </div>
              <div className='rotation'>
                <AxisInput node={props.node} axis='y' step={0.05} min={-180} max={180} value={rotation[1]} onChange={value => setRotation([rotation[0], value, rotation[2]]) } />
                <AxisInput node={props.node} axis='y' step={1} value={rotation[1]} onChange={(value) => { setRotation([rotation[0], value, rotation[2]]); }} />
              </div>
              <div className='rotation'>
                <AxisInput node={props.node} axis='z' step={0.05} min={-180} max={180} value={rotation[2]} onChange={value => setRotation([rotation[0], rotation[1], value]) } />
                <AxisInput node={props.node} axis='z' step={1} value={rotation[2]} onChange={(value) => { setRotation([rotation[0], rotation[1], value]); }} />
              </div>
            </div>
          </div>
        <div className='axisEditorContainer'>
            <div className='axisEditor'>
                <div className='label'>Scale</div>
                <AxisInput node={props.node} axis='x' step={0.05} value={scale[0]} onChange={ value => setScale([value, scale[1], scale[2]]) } />
                <AxisInput node={props.node} axis='y' step={0.05} value={scale[1]} onChange={ value => setScale([scale[0], value, scale[2]]) } />
                <AxisInput node={props.node} axis='z' step={0.05} value={scale[2]} onChange={ value => setScale([scale[0], scale[1], value]) } />
            </div>
        </div>
      </div>
    </Collapsable>
  )
}
