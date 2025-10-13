import { ButtonWithConfirm } from '../../../components/Button'
import { Logger, Node } from 'cleo'
import { useState, useEffect } from 'react';
import { useCleoEngine } from '../../EngineContext';
import Collapsable from '../../../components/Collapsable'

export default function NodeInfo(props: {node: Node}) {
  const { eventEmitter: eventEmitter } = useCleoEngine();
  const [nodeName, setNodeName] = useState(props.node.name);

  useEffect(() => {
    setNodeName(props.node.name);
  }, [props.node]);

  const handleNodeNameChange = () => {
    if (nodeName === props.node.name) return;
    if (nodeName === '') {
      Logger.warn('Node name cannot be empty', 'Editor');
      setNodeName(props.node.name);
      return;
    }
    if (nodeName === 'root') {
      Logger.warn('"root" name is reserved for the root node', 'Editor');
      setNodeName(props.node.name);
      return;
    }
    if (nodeName.includes('__debug__')) {
      Logger.warn('Node name cannot contain "__debug__"', 'Editor');
      setNodeName(props.node.name);
      return;
    }
    if (nodeName.includes('__editor__')) {
      Logger.warn('Node name cannot contain "__editor__"', 'Editor');
      setNodeName(props.node.name);
      return;
    }
    props.node.name = nodeName
    eventEmitter.emit('SCENE_CHANGED');
    eventEmitter.emit('SELECT_NODE', props.node.id);
  }

  return (
    <Collapsable title='Node Information'>
      <div className='w-full p-2'>
        <table className='w-full border-collapse'>
          <colgroup>
            <col span={1} style={{width: '25%'}} />
            <col span={1} style={{width: '75%'}} />
          </colgroup>
          <tbody>
            <tr className='border-b border-[#2d2d77]'>
              <td className='py-1 pr-2'> Name </td>
              <td className='py-1'> { props.node.name !== 'root' ? <input className='bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1' value={nodeName} onChange={(e) => setNodeName(e.target.value)} onBlur={handleNodeNameChange} /> : props.node.name } </td>
            </tr>
            <tr className='border-b border-[#2d2d77]'>
              <td className='py-1 pr-2'> ID </td>
              <td className='py-1'> {props.node.id} </td>
            </tr>
            <tr className='border-b border-[#2d2d77]'>
              <td className='py-1 pr-2'> Type </td>
              <td className='py-1'> { props.node.nodeType.charAt(0).toUpperCase() + props.node.nodeType.slice(1) } </td>
            </tr>
            <tr>
              <td className='py-1 pr-2'> Children </td>
              <td className='py-1'> {props.node.children.filter((child) => !(child.name.includes('__debug__') || child.name.includes('__editor__'))).length} </td>
            </tr>
          </tbody>
        </table>
        { props.node.name !== 'root' &&
          <div className='mt-2'>
            <ButtonWithConfirm onClick={() => props.node.remove()}>Delete</ButtonWithConfirm>
          </div>
        }
      </div>
    </Collapsable>
  )
}
