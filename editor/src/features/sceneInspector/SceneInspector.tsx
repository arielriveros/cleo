import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { Logger, ModelNode, Node } from 'cleo';
import CameraIcon from '../../icons/camera.png'
import ModelIcon from '../../icons/model.png'
import LightIcon from '../../icons/light.png'
import SkyboxIcon from '../../icons/skybox.png'
import SpriteIcon from '../../icons/sprite.png'
import VisibleIcon from '../../icons/visible.png'
import HiddenIcon from '../../icons/hidden.png'
import Collapsable from '../../components/Collapsable';
import AddNew from './AddNew';
import './Styles.css'

interface NodeDescription {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  children: any[];
}

interface SceneNodeItemProps {
  nodeId: string;
  nodeName?: string;
  nodeType?: string;
  children?: string[];
  onSelect: (nodeId: string) => void;
  expanded?: boolean;
  visible?: boolean;
  onSetVisibility: (nodeId: string) => void;
  onExpand: (nodeId: string) => void;
}
  
function SceneNodeItem(props: SceneNodeItemProps) {
  const { selectedNode } = useCleoEngine();

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData('text/plain', props.nodeId);
  };

  return (
    <div
      id={props.nodeId}
      className={`scene-item ${selectedNode === props.nodeId ? 'selected' : ''}`}
      onClick={() => props.onSelect(props.nodeId)}
      draggable={true}
      onDragStart={handleDragStart} >
      <div>
        { props.nodeType === 'camera' && <img src={CameraIcon} alt='camera' className='scene-item-icon' /> }
        { props.nodeType === 'model' && <img src={ModelIcon} alt='model' className='scene-item-icon' /> }
        { props.nodeType === 'sprite' && <img src={SpriteIcon} alt='sprite' className='scene-item-icon' /> }
        { props.nodeType === 'light' && <img src={LightIcon} alt='light' className='scene-item-icon' /> }
        { props.nodeType === 'skybox' && <img src={SkyboxIcon} alt='skybox' className='scene-item-icon' /> }
        { props.nodeName }
      </div>
      <div className='scene-item-options-container'>
        <img 
          onClick={ () => props.onSetVisibility(props.nodeId) }
          src={props.visible ? VisibleIcon : HiddenIcon} alt='visible' className='scene-item-visible-icon' />
        { props.children && props.children.length > 0 && 
          <div className='scene-item-expand-button' onClick={() => props.onExpand(props.nodeId)}>
            { props.expanded ? '>' : '∨' }
          </div>
        }
      </div>
    </div>
  );
}

interface SceneListRecursiveProps {
  node: NodeDescription;
  setSelectedNode: (nodeId: string | null) => void;
  handleSetVisibility: (nodeId: string) => void;
}
function SceneListRecursive(props: SceneListRecursiveProps) {
  const [expanded, setIsExpanded] = useState(true);

  return (
    props.node.name.includes('__debug__') ? null : 
    <div style={{ paddingLeft: 10 }}>
      <SceneNodeItem
        key={props.node.id}
        nodeId={props.node.id}
        nodeName={props.node.name}
        nodeType={props.node.type}
        onSelect={props.setSelectedNode}
        expanded={expanded}
        onExpand={() => setIsExpanded(!expanded) }
        visible={props.node.visible}
        onSetVisibility={props.handleSetVisibility}
        children={props.node.children}
        />
      { expanded ? 
        props.node.children.map( child => { return <SceneListRecursive key={child.id} node={child} setSelectedNode={props.setSelectedNode} handleSetVisibility={props.handleSetVisibility} /> })
      : <></>
      }
    </div>    
  );
}


export default function SceneInspector() {
  const { editorScene, eventEmitter, bodies } = useCleoEngine()
  const [ nodes, setNodes ] = useState<NodeDescription | null>(null);

  // generate a recursive list of id nodes where each node has a list of children
  function generateNodeList(node: Node): NodeDescription {
    return {
      id: node.id,
      name: node.name,
      type: node.nodeType,
      visible: node.visible,
      children: node.children.filter((child: Node) => !(child.name.includes('__debug__') || child.name.includes('__editor__'))).map((child: Node) => generateNodeList(child))
    }
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => { event.preventDefault() };
  
  const handleDrop: React.DragEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();

    // Find the closest parent div with the class 'sceneItem'
    const targetElement = (event.target as HTMLDivElement).closest('.scene-item');

    if (targetElement) {
      const targetId = targetElement.id;
      const draggedId = event.dataTransfer.getData('text/plain');

      if (draggedId === targetId) return; // Don't allow dropping onto the same node

      // Implement logic to update the hierarchy, e.g., update the parent of the dragged node
      const draggedNode = editorScene?.getNodeById(draggedId);
      const targetNode = editorScene?.getNodeById(targetId);

      if (!(draggedNode && targetNode)) return;

      // check if the dragged node is a parent of the target node
      if (targetNode.parent?.id === draggedNode.id) {
        Logger.warn('Cannot move a node to its child', 'Editor');
        return;
      }

      // check if the dragged node contains a body
      // TODO: Temporary solution, in the future inner nodes should be able to have bodies
      const body = bodies.get(draggedNode.id);
      if (body) {
        Logger.warn('Cannot move a node with a body', 'Editor');
        return;
      }
      
      targetNode.addChild(draggedNode);
    }
  };

  useEffect(() => {
    const handleSceneChanged = () => { if (editorScene) setNodes(generateNodeList(editorScene.root)) };
    eventEmitter.on('SCENE_CHANGED', handleSceneChanged);
    return () => { eventEmitter.off("SCENE_CHANGED", handleSceneChanged) }; // Remove the listener on component unmount
  }, [eventEmitter, editorScene]);

  const handleSelectNode = (nodeId: string | null) => {
    eventEmitter.emit('SELECT_NODE', nodeId);
  }

  const handleSetVisibility = (nodeId: string) => {
    const node = editorScene?.getNodeById(nodeId);
    if (node) node.visible = !node.visible;
  }

  return (
    <div className='sceneInspector' onDragOver={handleDragOver} onDrop={handleDrop}>
      <AddNew />
      <Collapsable title='Scene'>
        { nodes && <SceneListRecursive node={nodes} setSelectedNode={handleSelectNode} handleSetVisibility={handleSetVisibility} /> }
      </Collapsable>
    </div>
  )
}
