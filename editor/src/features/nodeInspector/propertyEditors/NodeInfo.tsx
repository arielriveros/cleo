import { Logger, Node } from 'cleo'
import { useState, useEffect } from 'react';
import { useCleoEngine } from '../../EngineContext';
import Collapsable from '../../../components/Collapsable'
import { PropertyTable, PropertyRow, TextInput, ButtonWithConfirm } from '../../../components/ui'
import { InfoIcon } from '../sectionIcons'

export default function NodeInfo(props: {node: Node, readOnly?: boolean}) {
  const { eventEmitter: eventEmitter, editorScene } = useCleoEngine();
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

  const childCount = props.node.children.filter((child) => !(child.name.includes('__debug__') || child.name.includes('__editor__'))).length;

  return (
    <Collapsable title='Node Information' icon={<InfoIcon />} persistKey='nodeInfo'>
      <div className='w-full p-2'>
        <PropertyTable columns={['28%', '72%']}>
          <PropertyRow label='Name'>
            {props.node.name !== 'root'
              ? <TextInput disabled={props.readOnly} className={props.readOnly ? 'opacity-60' : ''} value={nodeName} onChange={setNodeName} onBlur={handleNodeNameChange} />
              : <span className='text-muted'>{props.node.name}</span>}
          </PropertyRow>
          <PropertyRow label='ID'><span className='text-muted'>{props.node.id}</span></PropertyRow>
          <PropertyRow label='Type'><span className='text-muted'>{props.node.nodeType.charAt(0).toUpperCase() + props.node.nodeType.slice(1)}</span></PropertyRow>
          <PropertyRow label='Children' divider={false}><span className='text-muted'>{childCount}</span></PropertyRow>
        </PropertyTable>
        {props.node.name !== 'root' &&
          <div className='mt-2'>
            {/* Synchronous removal, not Node.remove(): that only sets markForRemoval and leaves the node
                in the tree until a later Scene.update sweep. Anything reading the tree in between — the
                mesh/template save paths do exactly this — sees a node the user has already deleted, and
                serialized it. Every other removal site in the editor uses removeNode for this reason
                (see sceneResync.ts, addCatalog.ts, PositionGizmo.tsx). */}
            <ButtonWithConfirm onClick={() => editorScene.removeNode(props.node)}>Delete</ButtonWithConfirm>
          </div>
        }
      </div>
    </Collapsable>
  )
}
