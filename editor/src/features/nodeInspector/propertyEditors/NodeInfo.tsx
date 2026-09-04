import { Logger, Node } from 'cleo'
import type { MotionBlurMode } from 'cleo'
import { useState, useEffect } from 'react';
import { useCleoEngine } from '../../EngineContext';
import Collapsable from '../../../components/Collapsable'
import { PropertyTable, PropertyRow, TextInput, ButtonWithConfirm, Toggle, Hint, SegmentedControl, Select } from '../../../components/ui'
import { InfoIcon } from '../sectionIcons'
import { validateNodeName } from '../../../utils/nodeNames'
import { modelNodeOf } from '../../../utils/models'
import { useHistory } from '../../HistoryContext'
import { CONVERTIBLE_NODE_TYPES, findNodeTypeOption, nodeTypeLabel } from '../../sceneInspector/nodeTypeCatalog'
import { findAddItem } from '../../sceneInspector/addCatalog'
import { prepareNodeTypeChange, rebuildNodeInPlace } from '../../../utils/nodeTypeConversion'
import { baseTypeMatchesNode } from '../../../utils/scripts'

const MOTION_BLUR_OPTIONS: { value: MotionBlurMode; label: string; title: string }[] = [
  { value: 'full', label: 'Full', title: 'The true screen-space motion. A node travelling with the camera does not move on screen, so it already stays sharp.' },
  { value: 'objectOnly', label: 'Object', title: 'The camera’s contribution removed — stays sharp however hard the camera pans, but still blurs when the node crosses the world.' },
  { value: 'none', label: 'None', title: 'Never blurred, and never smeared over by neighbouring streaks either.' },
]

export default function NodeInfo(props: {node: Node, readOnly?: boolean, allowTypeChange?: boolean}) {
  const { eventEmitter: eventEmitter, editorScene, scriptAssetOf, attachScriptToNode, detachScriptFromNode } = useCleoEngine();
  const { push, silently } = useHistory();
  const [nodeName, setNodeName] = useState(props.node.name);
  const [spawnOnStart, setSpawnOnStart] = useState(props.node.spawnOnStart);
  const [motionBlur, setMotionBlur] = useState<MotionBlurMode>(props.node.motionBlur);
  const [converting, setConverting] = useState(false);

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

  // The node OBJECT is replaced by a conversion while its id is not, so nothing keyed on the id re-resolves
  // on its own: useSelectedNode's effect deps are [editorScene, selectedNode] and neither changed, so this
  // panel would keep rendering the destroyed node; and HistoryContext's snapshot baseline for the id still
  // holds the OLD type's subtree, so the next unrelated edit would record an undo that also reverts the
  // conversion. Clearing the selection and re-setting it in a LATER task re-runs both effects — same-tick
  // React would batch the pair into a no-op state write.
  const reselectAfterConvert = (id: string) => {
    eventEmitter.emit('SCENE_CHANGED', { kind: 'structure' });
    eventEmitter.emit('SELECT_NODE', null);
    setTimeout(() => eventEmitter.emit('SELECT_NODE', id), 0);
  }

  const handleTypeChange = async (target: string) => {
    const option = findNodeTypeOption(target);
    if (!option || option.nodeType === props.node.nodeType || converting) return;
    // A <select> can fire again while a heavy root is still serializing, and the second call would
    // serialize a node the first is about to destroy.
    setConverting(true);
    const scene = editorScene;
    const nodeId = props.node.id;
    try {
      const item = option.defaultFrom ? findAddItem(option.defaultFrom) : undefined;
      // None of the offered items reads its AddContext (only Trigger and the two skies do, and all three
      // are outside the convertible set), so a throwaway trigger map is honest here.
      const prepared = await prepareNodeTypeChange(props.node, option.nodeType,
        item ? () => item.create({ editorScene: scene, eventEmitter, triggers: new Map() }) : null);
      if (!prepared) return;
      const { before, after } = prepared;

      // A script asset declares the node class it extends, and the link is keyed by node id — so it would
      // survive the rebuild and leave a Character script attached to a node that is no longer a Character,
      // to be re-applied on the next save. Decided BEFORE the rebuild so the undo can put it back; scripts
      // based on plain `node` attach to anything and are never touched.
      const script = scriptAssetOf(props.node);
      const strandedScript = script && !baseTypeMatchesNode(script.baseType, option.nodeType) ? script : null;

      // The rebuild fires a `remove` and an `add` structural event, which the recorder would file as two
      // unrelated undo steps, neither of which reverses the conversion. One hand-built entry replaces both.
      // `silently` only suspends for the duration of a SYNCHRONOUS call, which is why the async prep above
      // is already done by this point.
      const applyAfter = () => {
        silently(() => {
          const node = rebuildNodeInPlace(scene, after);
          // unlinkScript clears both the __scriptId variable and the id-keyed source, so the redo has to
          // repeat it: the `after` blob still carries the variable it was serialized with.
          if (node && strandedScript) detachScriptFromNode(node);
        });
        reselectAfterConvert(nodeId);
      }
      const applyBefore = () => {
        silently(() => {
          const node = rebuildNodeInPlace(scene, before);
          // `before` restores the __scriptId variable, but not the source in the scripts map — only
          // attachScriptToNode writes that.
          if (node && strandedScript) attachScriptToNode(node, strandedScript.id);
        });
        reselectAfterConvert(nodeId);
      }

      applyAfter();
      if (strandedScript)
        Logger.warn(`Detached script "${strandedScript.name}": it extends ${strandedScript.baseType} and cannot attach to a ${option.nodeType} node.`, 'Editor');
      push({ label: `Change type to ${option.label}`, undo: applyBefore, redo: applyAfter });
    } catch (e) {
      Logger.error(`Could not change node type to ${option.label}: ${e}`, 'Editor');
    } finally {
      setConverting(false);
    }
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
          <PropertyRow label='Type'
            hint={props.allowTypeChange
              ? 'What this template becomes when it is placed. Changing it rebuilds the root in place: its name, transform, children, variables, script and physics are kept, and everything specific to the old type — the mesh, the light, the camera — is replaced with a default for the new one. A Camera Rig arrives without its camera, since the children you already have are kept instead. Undoable.'
              : undefined}>
            {props.allowTypeChange && !props.readOnly
              ? <Select className='w-full' value={props.node.nodeType} disabled={converting}
                  onChange={(e) => void handleTypeChange(e.target.value)}>
                  {/* A root that is already something not on the list — an old template rooted at a skybox —
                      still needs its own value present, or the select silently displays the first option. */}
                  {!findNodeTypeOption(props.node.nodeType) &&
                    <option value={props.node.nodeType}>{nodeTypeLabel(props.node.nodeType)}</option>}
                  {CONVERTIBLE_NODE_TYPES.map(o => <option key={o.nodeType} value={o.nodeType}>{o.label}</option>)}
                </Select>
              : <span className='text-muted'>{nodeTypeLabel(props.node.nodeType)}</span>}
          </PropertyRow>
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
