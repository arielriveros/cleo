import { useEffect, useState } from 'react';
import { Node } from 'cleo';
import Collapsable from '../../../components/Collapsable';
import AxisInput from '../../../components/AxisInput';
import './Styles.css'

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

  const reset = () => {
    setPosition([0, 0, 0]);
    setRotation([0, 0, 0]);
    setScale([1, 1, 1]);
  }

  return (
    <Collapsable title='Transform'>
      <div className='transform-container'>
        <div className='transform-axis-container'>
          <table>
            <colgroup>
              <col span={1} style={{width: '25%'}} />
              <col span={1} style={{width: '75%'}} />
            </colgroup>
            <thead>
            </thead>
            <tbody>
              <tr>
                <td> Position </td>
                <td>
                  <AxisInput step={0.01} value={[position[0], position[1], position[2]]} onChange={(value) => setPosition(value)} />
                </td>
              </tr>
              <tr>
                <td> Rotation </td>
                <td>
                  <AxisInput step={0.1} min={-180} max={180} value={[rotation[0], rotation[1], rotation[2]]} onChange={value => setRotation(value) } />
                </td>
              </tr>
              <tr>
                <td> Scale </td>
                <td>
                  <AxisInput step={0.01} value={[scale[0], scale[1], scale[2]]} onChange={(value) => setScale(value)} />
                </td>
              </tr>
              <tr>
                <td> World Position </td>
                <td>
                  <div className='inline'>
                    {Array.from(props.node.worldPosition).map((value, index) => ( <p key={index}>{value.toFixed(2)}</p> ))}
                  </div>
                </td>
              </tr>
              <tr>
                <td> Quaternion </td>
                <td>
                  <div className='inline'>
                    {Array.from(props.node.quaternion).map((value, index) => ( <p key={index}>{value.toFixed(2)}</p> ))}
                  </div>
                </td>
              </tr>
              <tr>
                <td> World Quaternion </td>
                <td>
                  <div className='inline'>
                    {Array.from(props.node.worldQuaternion).map((value, index) => ( <p key={index}>{value.toFixed(2)}</p> ))}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <button onClick={reset}>Reset</button>
        </div>
      </div>
    </Collapsable>
  )
}
