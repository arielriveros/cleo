import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { Logger, ModelNode, Node } from 'cleo';
import CameraIcon from '../../icons/camera.png'
import ModelIcon from '../../icons/model.png'
import LightIcon from '../../icons/light.png'
import SkyboxIcon from '../../icons/skybox.png'
import CloudsIcon from '../../icons/clouds.png'
import SkyAtmosphereIcon from '../../icons/sky-atmosphere.png'
import SpriteIcon from '../../icons/sprite.png'
import VisibleIcon from '../../icons/visible.png'
import HiddenIcon from '../../icons/hidden.png'
import Collapsable from '../../components/Collapsable';
import AddNew from './AddNew';
import { TEMPLATE_ID_VAR } from '../../utils/templates';

interface NodeDescription {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  templateId?: string;
  children: any[];
}

interface SceneNodeItemProps {
  nodeId: string;
  nodeName?: string;
  nodeType?: string;
  children?: string[];
  templateId?: string;
  onSelect: (nodeId: string) => void;
  expanded?: boolean;
  visible?: boolean;
  onSetVisibility: (nodeId: string) => void;
  onExpand: (nodeId: string) => void;
}

const PenIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
  </svg>
);

function SceneNodeItem(props: SceneNodeItemProps) {
  const { selectedNode, enterTemplateEditor } = useCleoEngine();
  const selected = selectedNode === props.nodeId;

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData('text/plain', props.nodeId);
  };

  return (
    <div
      id={props.nodeId}
      className={`scene-item group flex w-[90%] h-[24px] py-[1px] px-[5px] mb-[1px] rounded-[2px] text-ellipsis overflow-hidden whitespace-nowrap justify-between ${selected ? 'bg-[#2c2cff] border border-white cursor-default' : 'border border-[#3b3b3b] hover:bg-[#3f3fb4] cursor-pointer'}`}
      onClick={() => props.onSelect(props.nodeId)}
      draggable={true}
      onDragStart={handleDragStart} >
      <div>
        { props.nodeType === 'camera' && <img src={CameraIcon} alt='camera' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeType === 'model' && <img src={ModelIcon} alt='model' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeType === 'sprite' && <img src={SpriteIcon} alt='sprite' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeType === 'animatedSprite' && <img src={SpriteIcon} alt='animated sprite' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeType === 'light' && <img src={LightIcon} alt='light' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeType === 'lightProbe' && <img src={SkyboxIcon} alt='light probe' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeType === 'skybox' && <img src={SkyboxIcon} alt='skybox' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeType === 'volumetricClouds' && <img src={CloudsIcon} alt='volumetric clouds' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeType === 'skyAtmosphere' && <img src={SkyAtmosphereIcon} alt='sky atmosphere' className='inline-block w-4 h-4 mr-1 align-middle' /> }
        { props.nodeName }
      </div>
      <div className='flex flex-row items-center'>
        { props.templateId &&
          <button
            title='Edit template'
            onClick={(e) => { e.stopPropagation(); enterTemplateEditor(props.templateId); }}
            className='inline-flex items-center justify-center w-4 h-4 mr-1 text-white hover:text-[#8f8fff]'>
            <PenIcon />
          </button>
        }
        <img
          onClick={ (e) => { e.stopPropagation(); props.onSetVisibility(props.nodeId); } }
          src={props.visible ? VisibleIcon : HiddenIcon} alt='visible'
          className={`inline-block w-4 h-4 mr-1 align-middle ${props.visible ? 'opacity-0 group-hover:opacity-100 transition-opacity' : ''}`} />
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
        templateId={props.node.templateId}
        />
      { expanded ? 
        props.node.children.map( child => { return <SceneListRecursive key={child.id} node={child} setSelectedNode={props.setSelectedNode} handleSetVisibility={props.handleSetVisibility} /> })
      : <></>
      }
    </div>    
  );
}


export default function SceneInspector() {
  const { editorScene, eventEmitter, bodies, isPlayMode, editorMode, templateRootId } = useCleoEngine()
  const [ nodes, setNodes ] = useState<NodeDescription | null>(null);

  // In template mode the inspector is rooted at the template node itself, so the editor camera/light
  // (siblings under the real scene root) fall outside the rendered subtree and stay hidden.
  const treeRoot = (): Node | undefined =>
    (editorMode === 'template' && templateRootId) ? editorScene.getNodeById(templateRootId) : editorScene.root;

  // generate a recursive list of id nodes where each node has a list of children
  function generateNodeList(node: Node): NodeDescription {
    // Template instance roots collapse to a single leaf row (with a pen icon) in scene mode.
    // The guard is essential: in template mode the tree is rooted at the template's own
    // instance root, which also carries the marker — pruning there would hide the very
    // content being edited.
    const templateId = editorMode === 'scene' ? node.getVariable(TEMPLATE_ID_VAR) : undefined;
    return {
      id: node.id,
      name: node.name,
      type: node.nodeType,
      visible: node.visible,
      templateId,
      children: templateId ? [] : node.children
        .filter((child: Node) => !(child.name.includes('__debug__') || child.name.includes('__editor__') || child.nodeType === 'landscape'))
        .map((child: Node) => generateNodeList(child))
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
    const rebuild = () => { const r = treeRoot(); if (r) setNodes(generateNodeList(r)); };
    rebuild(); // also rebuild immediately when the mode / template root changes
    eventEmitter.on('SCENE_CHANGED', rebuild);
    return () => { eventEmitter.off("SCENE_CHANGED", rebuild) }; // Remove the listener on component unmount
  }, [eventEmitter, editorScene, editorMode, templateRootId]);

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
