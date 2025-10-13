import { useEffect, useState } from 'react';
import { Node } from 'cleo';
import Collapsable from '../../../components/Collapsable';
import AxisInput from '../../../components/AxisInput';

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
      <div className='w-full text-white'>
        <div className='w-full p-2'>
          <table className='w-full border-collapse'>
            <colgroup>
              <col span={1} style={{width: '25%'}} />
              <col span={1} style={{width: '75%'}} />
            </colgroup>
            <tbody>
              <tr className='border-b border-[#2d2d77]'>
                <td className='py-1 pr-2'> Position </td>
                <td className='py-1'>
                  <AxisInput step={0.01} value={[position[0], position[1], position[2]]} onChange={(value) => setPosition(value)} />
                </td>
              </tr>
              <tr className='border-b border-[#2d2d77]'>
                <td className='py-1 pr-2'> Rotation </td>
                <td className='py-1'>
                  <AxisInput step={0.1} min={-180} max={180} value={[rotation[0], rotation[1], rotation[2]]} onChange={value => setRotation(value) } />
                </td>
              </tr>
              <tr className='border-b border-[#2d2d77]'>
                <td className='py-1 pr-2'> Scale </td>
                <td className='py-1'>
                  <AxisInput step={0.01} value={[scale[0], scale[1], scale[2]]} onChange={(value) => setScale(value)} />
                </td>
              </tr>
              <tr className='border-b border-[#2d2d77]'>
                <td className='py-1 pr-2'> World Position </td>
                <td className='py-1'>
                  <div className='inline-flex gap-2'>
                    {Array.from(props.node.worldPosition).map((value, index) => ( <p key={index}>{value.toFixed(2)}</p> ))}
                  </div>
                </td>
              </tr>
              <tr className='border-b border-[#2d2d77]'>
                <td className='py-1 pr-2'> Quaternion </td>
                <td className='py-1'>
                  <div className='inline-flex gap-2'>
                    {Array.from(props.node.quaternion).map((value, index) => ( <p key={index}>{value.toFixed(2)}</p> ))}
                  </div>
                </td>
              </tr>
              <tr>
                <td className='py-1 pr-2'> World Quaternion </td>
                <td className='py-1'>
                  <div className='inline-flex gap-2'>
                    {Array.from(props.node.worldQuaternion).map((value, index) => ( <p key={index}>{value.toFixed(2)}</p> ))}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <button className='mt-2 px-3 py-1 bg-[#3b3b3b] border border-[#2d2d77] rounded hover:bg-[#3f3fb4]' onClick={reset}>Reset</button>
        </div>
      </div>
    </Collapsable>
  )
}
