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
import { NEW_NODE_MIME, addItemTo, findAddItem } from './addCatalog';
import { TEMPLATE_ID_VAR, isWithinTemplateInstance } from '../../utils/templates';
import { SCRIPT_ID_VAR, getScriptIdOf } from '../../utils/scripts';
import { hoveredScriptStore, useHoveredScript } from './hoveredScriptStore';

interface NodeDescription {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  templateId?: string;
  scriptId?: string;
  children: any[];
}

interface SceneNodeItemProps {
  nodeId: string;
  nodeName?: string;
  nodeType?: string;
  children?: string[];
  templateId?: string;
  scriptId?: string;
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

// A code-brackets glyph marking a node that carries a script. `</>` reads as "script/code" at 14px.
const ScriptIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 6 3 12l5 6" />
    <path d="M16 6l5 6-5 6" />
  </svg>
);

function SceneNodeItem(props: SceneNodeItemProps) {
  const { selectedNode, enterTemplateEditor, enterScriptEditor } = useCleoEngine();
  const selected = selectedNode === props.nodeId;
  const hoveredScript = useHoveredScript();
  // A script glyph on a template-instance node is greyed (its script is authored in the template, not here)
  // but stays clickable. Highlight this node's glyph when its script is the one being hovered anywhere.
  const scriptGrey = !!props.templateId;
  const scriptHot = !!props.scriptId && props.scriptId === hoveredScript;

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    // Dedicated MIME so drop targets can tell a scene node from other text/plain drags (dock tabs,
    // text selections); text/plain kept as a fallback payload for anything generic.
    event.dataTransfer.setData('text/cleo-node', props.nodeId);
    event.dataTransfer.setData('text/plain', props.nodeId);
  };

  return (
    <div
      id={props.nodeId}
      className={`scene-item group flex w-[90%] h-[24px] py-[1px] px-[5px] mb-[1px] rounded-[2px] text-ellipsis overflow-hidden whitespace-nowrap justify-between ${selected ? 'bg-selected border border-white cursor-default' : 'border border-control hover:bg-control-hover cursor-pointer'}`}
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
        { props.scriptId &&
          <button
            title={scriptGrey ? 'Edit script (authored in the template)' : 'Edit script'}
            onClick={(e) => { e.stopPropagation(); enterScriptEditor(props.scriptId); }}
            onMouseEnter={() => hoveredScriptStore.set(props.scriptId ?? null)}
            onMouseLeave={() => hoveredScriptStore.set(null)}
            className={`inline-flex items-center justify-center w-4 h-4 mr-1 ${
              scriptHot ? 'text-highlight' : scriptGrey ? 'text-white/40 hover:text-white/70' : 'text-white hover:text-highlight'}`}>
            <ScriptIcon />
          </button>
        }
        { props.templateId &&
          <button
            title='Edit template'
            onClick={(e) => { e.stopPropagation(); enterTemplateEditor(props.templateId); }}
            className='inline-flex items-center justify-center w-4 h-4 mr-1 text-white hover:text-highlight'>
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
        scriptId={props.node.scriptId}
        />
      { expanded ? 
        props.node.children.map( child => { return <SceneListRecursive key={child.id} node={child} setSelectedNode={props.setSelectedNode} handleSetVisibility={props.handleSetVisibility} /> })
      : <></>
      }
    </div>    
  );
}


export default function SceneInspector() {
  const { editorScene, eventEmitter, bodies, triggers, isPlayMode, editorMode, templateRootId, attachScriptToNode } = useCleoEngine()
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
      scriptId: getScriptIdOf(node),
      children: templateId ? [] : node.children
        .filter((child: Node) => !(child.name.includes('__debug__') || child.name.includes('__editor__') || child.nodeType === 'landscape'))
        .map((child: Node) => generateNodeList(child))
    }
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    // Only the kinds the tree actually accepts, so unrelated drags don't read as droppable here.
    const types = Array.from(event.dataTransfer.types);
    if (types.includes('text/cleo-node') || types.includes(NEW_NODE_MIME) || types.includes('text/cleo-script')) event.preventDefault();
  };

  const handleDrop: React.DragEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();

    // Find the closest parent div with the class 'sceneItem'
    const targetElement = (event.target as HTMLDivElement).closest('.scene-item');

    // A script asset dragged from the Assets explorer: attach it to the node it was dropped on (base-type
    // enforced by attachScriptToNode). Read-only template-instance nodes are skipped.
    const scriptId = event.dataTransfer.getData('text/cleo-script');
    if (scriptId) {
      const node = targetElement ? editorScene?.getNodeById(targetElement.id) : null;
      if (!node) { Logger.warn('Drop the script onto a node to attach it', 'Editor'); return; }
      if (editorMode === 'scene' && isWithinTemplateInstance(node)) {
        Logger.warn('Cannot attach a script to a template instance', 'Editor');
        return;
      }
      attachScriptToNode(node, scriptId);
      return;
    }

    // A new node dragged out of the Add section: parent it under the row it was dropped on, or under the
    // tree root when dropped on the empty space below the tree.
    const newNodeId = event.dataTransfer.getData(NEW_NODE_MIME);
    if (newNodeId) {
      const item = findAddItem(newNodeId);
      const parent = targetElement ? editorScene?.getNodeById(targetElement.id) : treeRoot();
      if (!item || !parent) return;
      if (editorMode === 'scene' && isWithinTemplateInstance(parent)) {
        Logger.warn('Cannot add a node inside a template instance', 'Editor');
        return;
      }
      addItemTo(item, parent, { editorScene, eventEmitter, triggers }).catch(err => console.error(err));
      return;
    }

    if (targetElement) {
      const targetId = targetElement.id;
      const draggedId = event.dataTransfer.getData('text/cleo-node') || event.dataTransfer.getData('text/plain');

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
    <div className='flex flex-col text-white bg-surface-raised w-full h-full'>
      <AddNew />
      {/* The drop target is the tree, not the whole panel: the panel also contains the Add section, and a
          drag released back over Add must not register as a drop into the scene. */}
      <Collapsable title='Scene'>
        <div className='min-h-[40px]' onDragOver={handleDragOver} onDrop={handleDrop}>
          { nodes && <SceneListRecursive node={nodes} setSelectedNode={handleSelectNode} handleSetVisibility={handleSetVisibility} /> }
        </div>
      </Collapsable>
    </div>
  )
}
