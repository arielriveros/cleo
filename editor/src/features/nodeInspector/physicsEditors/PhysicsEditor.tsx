import { useEffect, useMemo, useState } from 'react';
import { ModelNode, AnimatedModel, Node, RAGDOLL_DEFAULTS, hullFromPositions } from 'cleo'
import type { RagdollOptions, HullQuality } from 'cleo'
import { BodyDescription, ShapeDescription, useCleoEngine } from '../../EngineContext';
import Collapsable from '../../../components/Collapsable'
import AxisInput from '../../../components/AxisInput'
import ShapeEditor from './ShapeEditor';
import { HULL_QUALITIES } from './hullQuality';
import { collectHullPositions } from '../../../utils/editorHelpers';
import { Field, Slider, Toggle, Select, NumberInput, Button, Section, Hint, SegmentedControl } from '../../../components/ui'
import { PhysicsIcon, ShapeIcon } from '../sectionIcons'

const LABEL = 'w-[130px]';

// 3 axis toggles (used for linear/angular constraints; value is a [x,y,z] of 0|1).
// Declared at module scope: a component defined inside a render body is a *new type* on every render,
// which remounts its subtree and would wipe the drag state of the vector inputs below it.
const AxisToggles = ({ label, value, onChange }: { label: string; value: number[]; onChange: (v: number[]) => void }) => (
  <Field label={label} labelClassName={LABEL}>
    <div className='flex items-center gap-3'>
      {(['X', 'Y', 'Z'] as const).map((ax, i) => (
        <span key={ax} className='inline-flex items-center gap-1'>
          <span className='text-[10px] text-muted w-2'>{ax}</span>
          <Toggle checked={value[i] === 1} onChange={(c) => { const n = [...value]; n[i] = c ? 1 : 0; onChange(n); }} />
        </span>
      ))}
    </div>
  </Field>
);

/**
 * Shape list plus the add-shape row. `canHull` is true when the node subtree has static mesh
 * geometry to fit a convex hull to — skinned meshes don't qualify, because a hull of the bind pose
 * would not follow the animated silhouette.
 */
const ShapeTools = ({ shapes, canHull, addShape, addHull, regenerateHull, setShape, removeShape }: {
  shapes: ShapeDescription[];
  canHull: boolean;
  addShape: (type: string) => void;
  addHull: (quality: HullQuality) => boolean;
  regenerateHull: (index: number, quality: HullQuality) => boolean;
  setShape: (i: number, s: any) => void;
  removeShape: (i: number) => void;
}) => {
  const [quality, setQuality] = useState<HullQuality>('medium');
  const [degenerate, setDegenerate] = useState(false);

  return (
    <Section title='Shapes'>
      <div className='flex items-center gap-1.5 flex-wrap mb-2'>
        <span className='text-xs text-muted mr-1'>Add:</span>
        {['box', 'sphere', 'cylinder', 'plane'].map((t) => (
          <Button key={t} size='sm' onClick={() => addShape(t)}>{t.charAt(0).toUpperCase() + t.slice(1)}</Button>
        ))}
      </div>

      { canHull && <div className='mb-3'>
        <Field label='Hull Definition' labelClassName='w-[100px]'>
          <SegmentedControl size='sm' grow options={HULL_QUALITIES} value={quality} onChange={(v) => setQuality(v as HullQuality)} />
        </Field>
        <Button size='sm' className='mt-1.5' onClick={() => setDegenerate(!addHull(quality))}>Add Convex Hull</Button>
        { degenerate && <Hint className='mt-1'>This mesh is flat or has too few vertices to form a hull.</Hint> }
      </div> }

      {shapes.map((shape, i) => (
        <ShapeEditor
          key={i}
          shape={shape}
          setShape={(s: any) => setShape(i, s)}
          removeShape={() => removeShape(i)}
          regenerateHull={canHull ? (q) => regenerateHull(i, q) : undefined}
        />
      ))}
    </Section>
  );
};

export default function PhysicsEditor(props: {node: Node}) {
  const { bodies, triggers, eventEmitter: eventEmitter } = useCleoEngine();
  const [bodyProperties, setBodyProperties] = useState<BodyDescription | null>(null)
  const [triggerProperties, setTriggerProperties] = useState<{shapes: ShapeDescription[]} | null>(null);
  const [ragdoll, setRagdoll] = useState<RagdollOptions | null>(null);
  const [sceneChanged, setSceneChanged] = useState(false);

  // Ragdoll only applies to skinned meshes (ModelNode with a skinned AnimatedModel + animator).
  const modelNode = props.node as ModelNode;
  const isSkinned =
    props.node.nodeType === 'model' &&
    modelNode.model instanceof AnimatedModel &&
    modelNode.model.hasSkin &&
    !!modelNode.animator;

  useEffect(() => {
    const handleSceneChanged = () => { setSceneChanged(true); };
    eventEmitter.on('SCENE_CHANGED', handleSceneChanged);
    return () => { eventEmitter.off('SCENE_CHANGED', handleSceneChanged) };
  }, [eventEmitter]);

  useEffect(() => {
    if(sceneChanged) setSceneChanged(false)
  }, [sceneChanged]);

  useEffect(() => {
    const body = bodies.get(props.node.id);
    if (body)
      setBodyProperties({
        mass: body.mass,
        linearDamping: body.linearDamping,
        angularDamping: body.angularDamping,
        linearConstraints: body.linearConstraints,
        angularConstraints: body.angularConstraints,
        shapes: body.shapes
      })
    else setBodyProperties(null)
  }, [props.node, bodies])

  // Persist body edits to the shared map; the editor-helper reconciler rebuilds the debug wireframe.
  useEffect(() => {
    if (bodyProperties) {
      bodies.set(props.node.id, {
        mass: bodyProperties.mass,
        linearDamping: bodyProperties.linearDamping,
        angularDamping: bodyProperties.angularDamping,
        linearConstraints: bodyProperties.linearConstraints,
        angularConstraints: bodyProperties.angularConstraints,
        shapes: bodyProperties.shapes
      });
      eventEmitter.emit('PHYSICS_CHANGED');
    }
  }, [bodyProperties])

  useEffect(() => {
    const trigger = triggers.get(props.node.id);
    if (trigger)
      setTriggerProperties({shapes: trigger.shapes})
    else setTriggerProperties(null)
  }, [props.node, triggers])

  // Persist trigger edits to the shared map; the editor-helper reconciler rebuilds the debug wireframe.
  useEffect(() => {
    if (triggerProperties) {
      triggers.set(props.node.id, { shapes: triggerProperties.shapes });
      eventEmitter.emit('PHYSICS_CHANGED');
    }
  }, [triggerProperties])

  // Load ragdoll config from the node (merged over shared defaults) when a skinned mesh is selected.
  useEffect(() => {
    const m = props.node as ModelNode;
    const skinned = props.node.nodeType === 'model' && m.model instanceof AnimatedModel && m.model.hasSkin && !!m.animator;
    if (skinned) setRagdoll({ ...RAGDOLL_DEFAULTS, ...(m.ragdollConfig || {}) });
    else setRagdoll(null);
  }, [props.node]);

  // Persist ragdoll edits straight onto the node (serializes with the scene → survives Play/save/load).
  useEffect(() => {
    if (ragdoll && isSkinned) (props.node as ModelNode).ragdollConfig = ragdoll;
  }, [ragdoll]);

  // Whether this node (or any of its descendants) has static mesh geometry to fit a hull to. The
  // actual vertex gathering happens fresh on click, so child edits made after selection still count.
  const canHull = useMemo(() => collectHullPositions(props.node) !== null, [props.node, sceneChanged]);

  const writeShapes = (target: 'body' | 'trigger', shapes: ShapeDescription[]) => {
    if (target === 'body') setBodyProperties({ ...bodyProperties!, shapes });
    else setTriggerProperties({ ...triggerProperties!, shapes });
  };
  const shapesOf = (target: 'body' | 'trigger') =>
    (target === 'body' ? bodyProperties!.shapes : triggerProperties!.shapes);

  const addShape = (type: string, target: 'body' | 'trigger') => {
    const shape: any =
      type === 'box' ? { type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] } :
      type === 'sphere' ? { type: 'sphere', radius: 1, offset: [0, 0, 0], rotation: [0, 0, 0] } :
      type === 'cylinder' ? { type: 'cylinder', radius: 1, height: 1, numSegments: 16, offset: [0, 0, 0], rotation: [0, 0, 0] } :
      { type: 'plane', offset: [0, 0, 0], rotation: [0, 0, 0] };
    writeShapes(target, [...shapesOf(target), shape]);
  }

  // Hull vertices are baked into the descriptor (and so into the scene) rather than rebuilt on load.
  // They come back centered on their own centroid, which becomes the shape's starting offset.
  const buildHull = (quality: HullQuality): ShapeDescription | null => {
    const positions = collectHullPositions(props.node);
    const hull = positions ? hullFromPositions(positions, quality) : null;
    if (!hull) return null;
    return { type: 'convex', quality, vertices: hull.vertices, faces: hull.faces, offset: hull.center, rotation: [0, 0, 0], v: 2 };
  };

  const addHull = (target: 'body' | 'trigger', quality: HullQuality): boolean => {
    const shape = buildHull(quality);
    if (!shape) return false;
    writeShapes(target, [...shapesOf(target), shape]);
    return true;
  };

  const regenerateHull = (target: 'body' | 'trigger', index: number, quality: HullQuality): boolean => {
    const shape = buildHull(quality);
    if (!shape) return false;
    const shapes = [...shapesOf(target)];
    shapes[index] = { ...shape, rotation: shapes[index].rotation }; // a manual re-orientation survives
    writeShapes(target, shapes);
    return true;
  };

  const removeShape = (shapeIndex: number, target: 'body' | 'trigger') => {
    if (target === 'body' && bodyProperties) {
      const newShapes = [...bodyProperties.shapes];
      newShapes.splice(shapeIndex, 1);
      setBodyProperties({...bodyProperties, shapes: newShapes})
    }
    if (target === 'trigger' && triggerProperties) {
      const newShapes = [...triggerProperties.shapes];
      newShapes.splice(shapeIndex, 1);
      setTriggerProperties({...triggerProperties, shapes: newShapes})
    }
  };

  const removeBody = () => { bodies.delete(props.node.id); setBodyProperties(null); eventEmitter.emit('PHYSICS_CHANGED'); }
  const removeTrigger = () => { triggers.delete(props.node.id); setTriggerProperties(null); eventEmitter.emit('PHYSICS_CHANGED'); }

  const shapeTools = (target: 'body' | 'trigger', shapes: ShapeDescription[]) => (
    <ShapeTools
      shapes={shapes}
      canHull={canHull}
      addShape={(t) => addShape(t, target)}
      addHull={(q) => addHull(target, q)}
      regenerateHull={(i, q) => regenerateHull(target, i, q)}
      setShape={(i, s) => { const n = [...shapes]; n[i] = s; writeShapes(target, n); }}
      removeShape={(i) => removeShape(i, target)}
    />
  );

  return ( <>
    <Collapsable title='Rigid Body' icon={<PhysicsIcon />} badge={bodyProperties?.shapes.length || undefined} persistKey='rigidBody'>
      <div className='w-full p-2'>
        { !bodyProperties ?
          (props.node.name === 'root'
            ? <Hint>Root node cannot have a rigid body.</Hint>
            : props.node.parent?.name !== 'root'
              ? <Hint>Can only add rigid bodies to nodes at root level.</Hint>
              : <>
                  <Hint className='mb-2'>Node does not have a rigid body.</Hint>
                  <Button variant='primary' size='sm' onClick={() => setBodyProperties({ mass: 0, linearDamping: 0, angularDamping: 0, linearConstraints: [1, 1, 1], angularConstraints: [1, 1, 1], shapes: [] })}>Add Rigid Body</Button>
                </>)
          : <>
              <Field label='Mass' labelClassName={LABEL}>
                <NumberInput value={bodyProperties.mass} onChange={(v) => setBodyProperties({ ...bodyProperties, mass: v })} />
              </Field>
              {bodyProperties.mass === 0 && <Hint className='mb-1'>Mass of 0 will make the object static.</Hint>}
              <Slider label='Damping' labelClassName={LABEL} min={0} max={1} step={0.01} value={bodyProperties.linearDamping} onChange={(v) => setBodyProperties({ ...bodyProperties, linearDamping: v })} />
              <Slider label='Angular Damping' labelClassName={LABEL} min={0} max={1} step={0.01} value={bodyProperties.angularDamping} onChange={(v) => setBodyProperties({ ...bodyProperties, angularDamping: v })} />
              <AxisToggles label='Linear Constraints' value={bodyProperties.linearConstraints} onChange={(v) => setBodyProperties({ ...bodyProperties, linearConstraints: v as [number, number, number] })} />
              <AxisToggles label='Angular Constraints' value={bodyProperties.angularConstraints} onChange={(v) => setBodyProperties({ ...bodyProperties, angularConstraints: v as [number, number, number] })} />
              <Button variant='danger' size='sm' className='mt-2' onClick={removeBody}>Remove Rigid Body</Button>
              <div className='mt-2'>
                {shapeTools('body', bodyProperties.shapes)}
              </div>
            </>
        }
      </div>
    </Collapsable>

    <Collapsable title='Trigger' icon={<ShapeIcon />} badge={triggerProperties?.shapes.length || undefined} persistKey='trigger'>
      <div className='w-full p-2'>
        { !triggerProperties
          ? <>
              <Hint className='mb-2'>Node does not have a trigger.</Hint>
              <Button variant='primary' size='sm' onClick={() => setTriggerProperties({ shapes: [] })}>Add Trigger</Button>
            </>
          : <>
              <Button variant='danger' size='sm' onClick={removeTrigger}>Remove Trigger</Button>
              <div className='mt-2'>
                {shapeTools('trigger', triggerProperties.shapes)}
              </div>
            </>
        }
      </div>
    </Collapsable>

    { isSkinned && ragdoll &&
    <Collapsable title='Ragdoll' icon={<PhysicsIcon />} persistKey='ragdoll'>
      <div className='w-full p-2'>
        <Hint className='mb-2'>How this skinned mesh simulates when turned into a ragdoll.</Hint>
        <Field label='Joint Type' labelClassName={LABEL}>
          <Select value={ragdoll.jointType} onChange={(e) => setRagdoll({ ...ragdoll, jointType: e.target.value as 'ball' | 'coneTwist' })}>
            <option value='ball'>Ball (free, stable)</option>
            <option value='coneTwist'>Cone-Twist (limited)</option>
          </Select>
        </Field>
        { ragdoll.jointType === 'coneTwist' && <>
          <Slider label='Cone Angle' labelClassName={LABEL} min={0} max={180} step={1} value={ragdoll.coneAngle ?? 0} readout={(v) => `${v.toFixed(0)}°`} onChange={(v) => setRagdoll({ ...ragdoll, coneAngle: v })} />
          <Slider label='Twist Angle' labelClassName={LABEL} min={0} max={180} step={1} value={ragdoll.twistAngle ?? 0} readout={(v) => `${v.toFixed(0)}°`} onChange={(v) => setRagdoll({ ...ragdoll, twistAngle: v })} />
          <Field label='Stiffness' labelClassName={LABEL}><NumberInput value={ragdoll.stiffness ?? 0} onChange={(v) => setRagdoll({ ...ragdoll, stiffness: v })} /></Field>
        </> }
        <Slider label='Angular Damping' labelClassName={LABEL} min={0} max={1} step={0.01} value={ragdoll.angularDamping ?? 0} onChange={(v) => setRagdoll({ ...ragdoll, angularDamping: v })} />
        <Slider label='Linear Damping' labelClassName={LABEL} min={0} max={1} step={0.01} value={ragdoll.linearDamping ?? 0} onChange={(v) => setRagdoll({ ...ragdoll, linearDamping: v })} />
        <Field label='Bone Mass' labelClassName={LABEL}><NumberInput step={0.1} value={ragdoll.boneMass ?? 0} onChange={(v) => setRagdoll({ ...ragdoll, boneMass: v })} /></Field>
        <Field label='Radius Scale' labelClassName={LABEL}><NumberInput step={0.05} value={ragdoll.radiusScale ?? 0} onChange={(v) => setRagdoll({ ...ragdoll, radiusScale: v })} /></Field>
        <Field label='Self Collision' labelClassName={LABEL}><Toggle checked={!!ragdoll.selfCollision} onChange={(c) => setRagdoll({ ...ragdoll, selfCollision: c })} /></Field>
        <Field label='Knockback Impulse' labelClassName={LABEL}>
          <AxisInput step={0.1} value={[ragdoll.impulse?.[0] ?? 0, ragdoll.impulse?.[1] ?? 0, ragdoll.impulse?.[2] ?? 0]} onChange={(v) => setRagdoll({ ...ragdoll, impulse: [v[0], v[1], v[2]] })} />
        </Field>
      </div>
    </Collapsable>
    }
  </>)
}
