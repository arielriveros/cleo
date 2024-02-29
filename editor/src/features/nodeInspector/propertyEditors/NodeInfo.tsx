import { ButtonWithConfirm } from '../../../components/Button'
import { Logger, Node } from 'cleo'
import { useState, useEffect } from 'react';
import { useCleoEngine } from '../../EngineContext';
import Collapsable from '../../../components/Collapsable'
import './Styles.css'

export default function NodeInfo(props: {node: Node}) {
  const { eventEmmiter } = useCleoEngine();
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
    eventEmmiter.emit('SCENE_CHANGED');
    eventEmmiter.emit('SELECT_NODE', props.node.id);
  }

  return (
    <Collapsable title='Node Information'>
      <div className='node-info'>
        <table>
          <colgroup>
            <col span={1} style={{width: '25%'}} />
            <col span={1} style={{width: '75%'}} />
          </colgroup>
          <tbody>
            <tr>
              <td> Name </td>
              <td> { props.node.name !== 'root' ? <input value={nodeName} onChange={(e) => setNodeName(e.target.value)} onBlur={handleNodeNameChange} /> : props.node.name } </td>
            </tr>
            <tr>
              <td> ID </td>
              <td> {props.node.id} </td>
            </tr>
            <tr>
              <td> Type </td>
              <td> { props.node.nodeType.charAt(0).toUpperCase() + props.node.nodeType.slice(1) } </td>
            </tr>
            <tr>
              <td> Children </td>
              <td> {props.node.children.filter((child) => !(child.name.includes('__debug__') || child.name.includes('__editor__'))).length} </td>
            </tr>
          </tbody>
        </table>
        { props.node.name !== 'root' &&
          <ButtonWithConfirm onClick={() => props.node.remove()}>Delete</ButtonWithConfirm>
        }
      </div>
    </Collapsable>
  )
}
