import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { Node } from 'cleo';
import CameraIcon from '../../icons/camera.png'
import ModelIcon from '../../icons/model.png'
import LightIcon from '../../icons/light.png'
import SkyboxIcon from '../../icons/skybox.png'
import Collapsable from '../../components/Collapsable';
import AddNew from './AddNew';
import './Styles.css'

interface SceneNodeItemProps {
  nodeId: string;
  nodeName?: string;
  nodeType?: string;
  children?: string[];
  onSelect: (nodeId: string) => void;
  onExpand?: (nodeId: string) => void;
}
  
function SceneNodeItem(props: SceneNodeItemProps) {
  const { selectedNode } = useCleoEngine();

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData('text/plain', props.nodeId);
  };

  return (
    <div
      id={props.nodeId}
      className={`sceneItem ${selectedNode === props.nodeId ? 'selected' : ''}`}
      onClick={() => props.onSelect(props.nodeId)}
      draggable={true}
      onDragStart={handleDragStart} >
      <div>
        { props.nodeType === 'camera' && <img src={CameraIcon} alt='camera' className='sceneItemIcon' /> }
        { props.nodeType === 'model' && <img src={ModelIcon} alt='model' className='sceneItemIcon' /> }
        { props.nodeType === 'light' && <img src={LightIcon} alt='light' className='sceneItemIcon' /> }
        { props.nodeType === 'skybox' && <img src={SkyboxIcon} alt='skybox' className='sceneItemIcon' /> }
        { props.nodeName }
      </div>
      { props.children && props.children.length > 0 && <div onClick={() => props.onExpand && props.onExpand(props.nodeId)}>+</div> }
    </div>
  );
}

function SceneListRecursive(props: { node: { id: string, name: string, type: string, children: any[]}, setSelectedNode: (nodeId: string | null) => void}) {
  const [isVisible, setIsVisible] = useState(true);

  return (
    props.node.name.includes('__debug__') ? null : 
    <div style={{ paddingLeft: 5 }}>
      <SceneNodeItem
        key={props.node.id}
        nodeId={props.node.id}
        nodeName={props.node.name}
        nodeType={props.node.type}
        onSelect={props.setSelectedNode}
        onExpand={() => setIsVisible(!isVisible) }
        children={props.node.children}
        />
      { isVisible ? 
        props.node.children.map( child => { return <SceneListRecursive key={child.id} node={child} setSelectedNode={props.setSelectedNode}/> })
      : <></>
      }
    </div>    
  );
}


export default function SceneInspector() {
  const { editorScene, eventEmmiter, bodies } = useCleoEngine()
  const [ nodes, setNodes ] = useState<{ id: string, name: string, type: string, children: any[]} | null>(null);

  // generate a recursive list of id nodes where each node has a list of children
  // { id: 'root', children: [{ id: 'child1', children: [{ id: 'child3', children: [] }] }, { id: 'child2', children: [] }] }
  function generateNodeList(node: Node): { id: string, name: string, type: string, children: any[]} {
    return {
      id: node.id,
      name: node.name,
      type: node.nodeType,
      children: node.children.filter((child: Node) => !(child.name.includes('__debug__') || child.name.includes('__editor__'))).map((child: Node) => generateNodeList(child))
    }
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => { event.preventDefault() };
  
  const handleDrop: React.DragEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();

    // Find the closest parent div with the class 'sceneItem'
    const targetElement = (event.target as HTMLDivElement).closest('.sceneItem');

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
        console.log('Cannot drop a parent node onto its child');
        return;
      }

      // check if the dragged node contains a body
      // TODO: Temporary solution, in the future inner nodes should be able to have bodies
      const body = bodies.get(draggedNode.id);
      if (body) {
        console.log('Cannot move a node with a body');
        return;
      }
      
      targetNode.addChild(draggedNode);
    }
  };

  useEffect(() => {
    const handleSceneChanged = () => { if (editorScene) setNodes(generateNodeList(editorScene.root)) };
    eventEmmiter.on('SCENE_CHANGED', handleSceneChanged);
    return () => { eventEmmiter.off("SCENE_CHANGED", handleSceneChanged) }; // Remove the listener on component unmount
  }, [eventEmmiter, editorScene]);

  const handleSelectNode = (nodeId: string | null) => {
    eventEmmiter.emit('SELECT_NODE', nodeId);
  }

  return (
    <div className='sceneInspector' onDragOver={handleDragOver} onDrop={handleDrop}>
      <AddNew />
      <Collapsable title='Scene'>
        { nodes && <SceneListRecursive node={nodes} setSelectedNode={handleSelectNode}/> }
      </Collapsable>
    </div>
  )
}
