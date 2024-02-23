import { ButtonWithConfirm } from '../../../components/Button'
import { Node } from 'cleo'
import { useState, useEffect } from 'react';
import { useCleoEngine } from '../../EngineContext';
import Collapsable from '../../../components/Collapsable'
import './NodeInfo.css'

export default function NodeInfo(props: {node: Node}) {
  const { eventEmmiter, setSelectedNode } = useCleoEngine();
  const [nodeName, setNodeName] = useState(props.node.name);

  useEffect(() => {
    setNodeName(props.node.name);
  }, [props.node]);

  const handleNodeNameChange = () => {
    if (nodeName === props.node.name) return;
    if (nodeName === '') {
      console.warn('Node name cannot be empty');
      setNodeName(props.node.name);
      return;
    }
    if (nodeName === 'root') {
      console.warn('Cannot rename root node');
      setNodeName(props.node.name);
      return;
    }
    if (nodeName.includes('__debug__') || nodeName.includes('__editor__')) {
      console.warn('Node name cannot contain "__debug__" or "__editor__"');
      setNodeName(props.node.name);
      return;
    }
    props.node.name = nodeName
    eventEmmiter.emit('sceneChanged');
    setSelectedNode(props.node.id);
  }

  return (
    <Collapsable title='Node Information'>
      <div className='node-info'>
        <div className='info-item'>
          <b>Name:</b> { props.node.name !== 'root' ? <input value={nodeName} onChange={(e) => setNodeName(e.target.value)} onBlur={handleNodeNameChange} /> : props.node.name }
        </div>
        <div className='info-item'>
          <b>ID:</b> {props.node.id}
        </div>
        <div className='info-item'>
        <b>Type:</b> { props.node.nodeType.charAt(0).toUpperCase() + props.node.nodeType.slice(1) }
        </div>
        <div className='info-item'>
          <b>Children:</b> {props.node.children.filter((child) => !(child.name.includes('__debug__') || child.name.includes('__editor__'))).length}
        </div>
        { props.node.name !== 'root' &&
          <ButtonWithConfirm onClick={() => props.node.remove()}>Delete</ButtonWithConfirm>
        }
      </div>
    </Collapsable>
  )
}
