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
  const selected = selectedNode === props.nodeId;

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData('text/plain', props.nodeId);
  };

  return (
    <div
      id={props.nodeId}
      className={`scene-item flex w-[90%] h-[24px] py-[1px] px-[5px] mb-[1px] rounded-[2px] text-ellipsis overflow-hidden whitespace-nowrap justify-between ${selected ? 'bg-[#2c2cff] border border-white cursor-default' : 'border border-[#3b3b3b] hover:bg-[#3f3fb4] cursor-pointer'}`}
      onClick={() => props.onSelect(props.nodeId)}
      draggable={true}
      onDragStart={handleDragStart} >
      <div>
        { props.nodeType === 'camera' && <img src={CameraIcon} alt='camera' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeType === 'model' && <img src={ModelIcon} alt='model' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeType === 'sprite' && <img src={SpriteIcon} alt='sprite' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeType === 'animatedSprite' && <img src={SpriteIcon} alt='animated sprite' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeType === 'light' && <img src={LightIcon} alt='light' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeType === 'skybox' && <img src={SkyboxIcon} alt='skybox' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeName }
      </div>
      <div className='flex flex-row items-center'>
        <img 
          onClick={ () => props.onSetVisibility(props.nodeId) }
          src={props.visible ? VisibleIcon : HiddenIcon} alt='visible' className='inline-block w-4 h-4 mr-1 align-middle' />
        { props.children && props.children.length > 0 && 
          <div className='flex items-center justify-center w-[20px] h-[20px] text-white cursor-pointer select-none' onClick={() => props.onExpand(props.nodeId)}>
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
    <div className="pl-[10px]">
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
  const { editorScene, eventEmitter, bodies, isPlayMode } = useCleoEngine()
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
    // Don't allow node selection during play mode
    if (isPlayMode) return;
    eventEmitter.emit('SELECT_NODE', nodeId);
  }

  const handleSetVisibility = (nodeId: string) => {
    // Don't allow visibility changes during play mode
    if (isPlayMode) return;
    const node = editorScene?.getNodeById(nodeId);
    if (node) node.visible = !node.visible;
  }

  return (
    <div className='flex flex-col text-white bg-[#202020] w-full h-full' onDragOver={handleDragOver} onDrop={handleDrop}>
      <AddNew />
      <Collapsable title='Scene'>
        { nodes && <SceneListRecursive node={nodes} setSelectedNode={handleSelectNode} handleSetVisibility={handleSetVisibility} /> }
      </Collapsable>
    </div>
  )
}
