import { Logger, Node } from 'cleo'
import { useState, useEffect } from 'react';
import { useCleoEngine } from '../../EngineContext';
import Collapsable from '../../../components/Collapsable'
import { PropertyTable, PropertyRow, TextInput, ButtonWithConfirm, Toggle, Hint } from '../../../components/ui'
import { InfoIcon } from '../sectionIcons'

export default function NodeInfo(props: {node: Node, readOnly?: boolean}) {
  const { eventEmitter: eventEmitter, editorScene } = useCleoEngine();
  const [nodeName, setNodeName] = useState(props.node.name);
  const [spawnOnStart, setSpawnOnStart] = useState(props.node.spawnOnStart);

  useEffect(() => {
    setNodeName(props.node.name);
    setSpawnOnStart(props.node.spawnOnStart);
  }, [props.node]);

  // The flag is a RUNTIME rule — editing scenes set scene.spawnRulesEnabled = false, so the node stays
  // visible here whatever this says. Nothing to re-derive in the viewport, just the dirty mark.
  const handleSpawnOnStartChange = (value: boolean) => {
    setSpawnOnStart(value);
    props.node.spawnOnStart = value;
    eventEmitter.emit('SCENE_CHANGED');
  }

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

  // Any descendant that carries its own spawnOnStart=false — it will NOT wake when this node spawns.
  const hasDormantDescendant = (function anyDormant(node: Node): boolean {
    return node.children.some((child) => !child.spawnOnStart || anyDormant(child));
  })(props.node);

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
          <PropertyRow label='Children' divider={props.node.name !== 'root'}><span className='text-muted'>{childCount}</span></PropertyRow>
          {props.node.name !== 'root' &&
            <PropertyRow label='Spawn on start' divider={false}>
              <Toggle checked={spawnOnStart} disabled={props.readOnly} onChange={handleSpawnOnStartChange} />
            </PropertyRow>
          }
        </PropertyTable>
        {props.node.name !== 'root' && !spawnOnStart && <>
          <Hint className='mt-1'>Stays dormant when the game starts — no rendering, updates, animation or physics — until a script calls <code>spawn()</code> on it. It is still findable: <code>this.findNode('{props.node.name}').spawn()</code>. Only <code>onConstruct</code> runs while dormant, so a node can spawn itself from there.</Hint>
          {/* The trap that costs an hour: flagging a group AND its contents, then spawning the group and
              seeing nothing. Descendants keep their own flag by design (a spawner must not fire everything
              parked under it), so say so exactly where it is set. */}
          {hasDormantDescendant &&
            <Hint className='mt-1 text-warning'>A node below this one is also set to not spawn on start, and will stay dormant when this one spawns. Use <code>spawn(&#123; subtree: true &#125;)</code> to wake the whole group.</Hint>
          }
        </>}
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
