import { Logger, Node } from 'cleo'
import type { MotionBlurMode } from 'cleo'
import { useState, useEffect } from 'react';
import { useCleoEngine } from '../../EngineContext';
import Collapsable from '../../../components/Collapsable'
import { PropertyTable, PropertyRow, TextInput, ButtonWithConfirm, Toggle, Hint, SegmentedControl } from '../../../components/ui'
import { InfoIcon } from '../sectionIcons'
import { validateNodeName } from '../../../utils/nodeNames'
import { modelNodeOf } from '../../../utils/models'

const MOTION_BLUR_OPTIONS: { value: MotionBlurMode; label: string; title: string }[] = [
  { value: 'full', label: 'Full', title: 'The true screen-space motion. A node travelling with the camera does not move on screen, so it already stays sharp.' },
  { value: 'objectOnly', label: 'Object', title: 'The camera’s contribution removed — stays sharp however hard the camera pans, but still blurs when the node crosses the world.' },
  { value: 'none', label: 'None', title: 'Never blurred, and never smeared over by neighbouring streaks either.' },
]

export default function NodeInfo(props: {node: Node, readOnly?: boolean}) {
  const { eventEmitter: eventEmitter, editorScene } = useCleoEngine();
  const [nodeName, setNodeName] = useState(props.node.name);
  const [spawnOnStart, setSpawnOnStart] = useState(props.node.spawnOnStart);
  const [motionBlur, setMotionBlur] = useState<MotionBlurMode>(props.node.motionBlur);

  useEffect(() => {
    setNodeName(props.node.name);
    setSpawnOnStart(props.node.spawnOnStart);
    setMotionBlur(props.node.motionBlur);
  }, [props.node]);

  // The scene tree's inline rename mutates the same node object, so the effect above never re-runs for it.
  useEffect(() => {
    const onSceneChanged = (e?: { kind?: string; node?: Node }) => {
      if (e?.kind === 'name' && e.node === props.node) setNodeName(props.node.name);
    };
    eventEmitter.on('SCENE_CHANGED', onSceneChanged);
    return () => { eventEmitter.off('SCENE_CHANGED', onSceneChanged) };
  }, [eventEmitter, props.node]);

  // spawnOnStart is a RUNTIME rule: editing scenes set scene.spawnRulesEnabled = false, so the node stays
  // visible here whatever this says.
  const handleSpawnOnStartChange = (value: boolean) => {
    setSpawnOnStart(value);
    props.node.spawnOnStart = value;
    eventEmitter.emit('SCENE_CHANGED');
  }

  // The setter fans out to descendants, so setting it on an imported model's holder node reaches the
  // ModelNodes underneath — which are the ones the renderer actually draws.
  const handleMotionBlurChange = (value: MotionBlurMode) => {
    setMotionBlur(value);
    props.node.motionBlur = value;
    eventEmitter.emit('SCENE_CHANGED');
  }

  const handleNodeNameChange = () => {
    if (nodeName === props.node.name) return;
    // Same rules as the scene tree's inline rename, kept in one place so the two cannot drift.
    const problem = validateNodeName(nodeName);
    if (problem) {
      Logger.warn(problem, 'Editor');
      setNodeName(props.node.name);
      return;
    }
    props.node.name = nodeName
    eventEmitter.emit('SCENE_CHANGED');
    eventEmitter.emit('SELECT_NODE', props.node.id);
  }

  const childCount = props.node.children.filter((child) => !(child.name.includes('__debug__') || child.name.includes('__editor__'))).length;

  // Only nodes that put geometry on screen. The flag lives on Node so a holder can set it for its whole
  // subtree, but offering it on a light or an audio node would be noise.
  const hasGeometry = !!modelNodeOf(props.node);

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
            <PropertyRow label='Spawn on start' divider={hasGeometry}
              hint={`Off, the node stays dormant when the game starts — no rendering, updates, animation or physics — until a script calls spawn() on it. It is still findable: this.findNode('${props.node.name}').spawn(). Only onConstruct runs while dormant, so a node can spawn itself from there.`}>
              <Toggle checked={spawnOnStart} disabled={props.readOnly} onChange={handleSpawnOnStartChange} />
            </PropertyRow>
          }
          {props.node.name !== 'root' && hasGeometry &&
            <PropertyRow label='Motion blur' divider={false}
              hint='How much of the frame’s motion may blur this node. Full is the true screen motion — a character travelling with the camera does not move on screen and so is already sharp. Object removes the camera’s contribution, keeping the node crisp under any camera move while its own motion still streaks. None is never blurred at all, and is protected from neighbouring streaks too. Applies to the whole subtree.'>
              <SegmentedControl<MotionBlurMode> size='sm' grow className='flex w-full'
                options={props.readOnly ? MOTION_BLUR_OPTIONS.map(o => ({ ...o, disabled: true })) : MOTION_BLUR_OPTIONS}
                value={motionBlur} onChange={handleMotionBlurChange} />
            </PropertyRow>
          }
        </PropertyTable>
        {props.node.name !== 'root' && !spawnOnStart && <>
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
