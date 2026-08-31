import { useEffect, useMemo, useRef, useState } from 'react';
import { ModelNode, AnimatedModel, Node, RAGDOLL_DEFAULTS, hullFromPositions, Logger } from 'cleo'
import type { RagdollOptions, HullQuality } from 'cleo'
import { BodyDescription, ShapeDescription, useCleoEngine } from '../../EngineContext';
import Collapsable from '../../../components/Collapsable'
import AxisInput from '../../../components/AxisInput'
import ShapeEditor from './ShapeEditor';
import { HULL_QUALITIES } from './hullQuality';
import { collectHullPositions, meshBounds } from '../../../utils/editorHelpers';
import { Field, Slider, Toggle, Select, NumberInput, Button, Section, Hint, SegmentedControl, cn, labelClass } from '../../../components/ui'
import { PhysicsIcon, ShapeIcon } from '../sectionIcons'

const LABEL = 'w-[130px]';

const SIMULATE_HINT = 'Whether this body takes part in the physics solver. Off makes it a ghost — nothing collides with it, but it can still block a camera rig.';
const CAMERA_COLLISION_HINT = 'Whether camera rigs collide with this body. Off and they pass straight through it. Independent of Simulate Physics on purpose: scenery can block the camera without blocking the character, or the reverse.';
const MASS_HINT = 'Mass of 0 will make the object static.';
const FRICTION_HINT = 'Contact friction. At 0 the body is frictionless — nothing will slow it down but damping. What a character wants, since its script sets its own speed.';
const GROUND_PROBE_HINT = 'Counts as grounded while the collider’s feet are within this distance of solid ground, probed every frame. Removes isGrounded flicker (and false falling animations) for a character resting on terrain. Also what makes the groundDistance animation built-in answer. At 0 it is off and grounding comes from solver contacts only — raise it (~0.1–0.2) if a resting character flickers to airborne.';
const MOTION_SMOOTHING_HINT = 'Time constant for this body’s measured motion — currentSpeed, planarSpeed, acceleration, turn rate. Higher is steadier but slower to react. At 0 the default (~0.09s) applies. Raise it if an animation blend driven by this body’s speed vibrates or jitters; lower it if a script needs a faster answer than it gets.';

// 3 axis toggles (used for linear/angular constraints; value is a [x,y,z] of 0|1).
// Must stay at module scope: a component declared inside a render body is a new type every render, which
// remounts its subtree and wipes the drag state of the vector inputs.
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
 * Shape list plus the add-shape row. `canHull` is true when the node subtree has static mesh geometry
 * to fit a convex hull to; skinned meshes do not qualify.
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
        <span className={cn(labelClass, 'mr-1')}>Add:</span>
        {['box', 'sphere', 'capsule', 'cylinder', 'plane'].map((t) => (
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

  // Set while loading from the shared map, so the persist-effects below can tell a load from a user edit.
  const bodyLoadRef = useRef(false);
  const triggerLoadRef = useRef(false);

  useEffect(() => {
    const body = bodies.get(props.node.id);
    if (body) {
      bodyLoadRef.current = true;
      setBodyProperties({
        mass: body.mass,
        linearDamping: body.linearDamping,
        angularDamping: body.angularDamping,
        linearConstraints: body.linearConstraints,
        angularConstraints: body.angularConstraints,
        friction: body.friction ?? 0.3,
        restitution: body.restitution ?? 0,
        simulatePhysics: body.simulatePhysics ?? true,
        cameraCollision: body.cameraCollision ?? true,
        // 0 = ground probe off.
        groundProbeDistance: body.groundProbeDistance ?? 0,
        // 0 means "use the engine default (~0.09s)".
        motionSmoothing: body.motionSmoothing ?? 0,
        shapes: body.shapes
      })
    }
    else setBodyProperties(null)
  }, [props.node, bodies])

  useEffect(() => {
    if (bodyProperties) {
      bodies.set(props.node.id, {
        mass: bodyProperties.mass,
        linearDamping: bodyProperties.linearDamping,
        angularDamping: bodyProperties.angularDamping,
        linearConstraints: bodyProperties.linearConstraints,
        angularConstraints: bodyProperties.angularConstraints,
        friction: bodyProperties.friction,
        restitution: bodyProperties.restitution,
        simulatePhysics: bodyProperties.simulatePhysics,
        cameraCollision: bodyProperties.cameraCollision,
        groundProbeDistance: bodyProperties.groundProbeDistance,
        motionSmoothing: bodyProperties.motionSmoothing,
        shapes: bodyProperties.shapes
      });
      eventEmitter.emit('PHYSICS_CHANGED');
      if (bodyLoadRef.current) bodyLoadRef.current = false;
      else eventEmitter.emit('SCENE_CHANGED', { kind: 'physics', node: props.node });
    }
  }, [bodyProperties])

  useEffect(() => {
    const trigger = triggers.get(props.node.id);
    if (trigger) {
      triggerLoadRef.current = true;
      setTriggerProperties({shapes: trigger.shapes})
    }
    else setTriggerProperties(null)
  }, [props.node, triggers])

  useEffect(() => {
    if (triggerProperties) {
      triggers.set(props.node.id, { shapes: triggerProperties.shapes });
      eventEmitter.emit('PHYSICS_CHANGED');
      if (triggerLoadRef.current) triggerLoadRef.current = false;
      else eventEmitter.emit('SCENE_CHANGED', { kind: 'physics', node: props.node });
    }
  }, [triggerProperties])

  useEffect(() => {
    const m = props.node as ModelNode;
    const skinned = props.node.nodeType === 'model' && m.model instanceof AnimatedModel && m.model.hasSkin && !!m.animator;
    if (skinned) setRagdoll({ ...RAGDOLL_DEFAULTS, ...(m.ragdollConfig || {}) });
    else setRagdoll(null);
  }, [props.node]);

  // Ragdoll config lives on the node itself, so it serializes with the scene.
  useEffect(() => {
    if (ragdoll && isSkinned) (props.node as ModelNode).ragdollConfig = ragdoll;
  }, [ragdoll]);

  // The vertex gathering itself happens fresh on click, so child edits made after selection still count.
  const canHull = useMemo(() => collectHullPositions(props.node) !== null, [props.node, sceneChanged]);

  const writeShapes = (target: 'body' | 'trigger', shapes: ShapeDescription[]) => {
    if (target === 'body') setBodyProperties({ ...bodyProperties!, shapes });
    else setTriggerProperties({ ...triggerProperties!, shapes });
  };
  const shapesOf = (target: 'body' | 'trigger') =>
    (target === 'body' ? bodyProperties!.shapes : triggerProperties!.shapes);

  /**
   * Adds a shape fitted to the node's mesh and its descendants'. `meshBounds` works in node-local units —
   * the space shape descriptors are authored in — and includes skinned meshes. A mesh-less node keeps the
   * unit defaults.
   */
  const addShape = (type: string, target: 'body' | 'trigger') => {
    const b = meshBounds(props.node);
    const offset = b ? [b.center[0], b.center[1], b.center[2]] : [0, 0, 0];
    const rotation = [0, 0, 0];

    let shape: any;
    switch (type) {
      case 'box':
        shape = b
          ? { type: 'box', width: b.half[0] * 2, height: b.half[1] * 2, depth: b.half[2] * 2, offset, rotation }
          : { type: 'box', width: 1, height: 1, depth: 1, offset, rotation };
        break;
      case 'sphere':
        shape = { type: 'sphere', radius: b ? Math.max(b.half[0], b.half[1], b.half[2]) : 1, offset, rotation };
        break;
      case 'cylinder':
        shape = b
          ? { type: 'cylinder', radius: Math.max(b.half[0], b.half[2]), height: b.half[1] * 2, numSegments: 16, offset, rotation }
          : { type: 'cylinder', radius: 1, height: 1, numSegments: 16, offset, rotation };
        break;
      case 'capsule':
        // Torso-percentile radius, not the X/Z extent: a T-pose's arm span would give a sphere as wide as
        // the character. The floor keeps a zero radius from reaching cannon.
        shape = b
          ? { type: 'capsule', radius: Math.max(b.radius, 0.01), height: b.half[1] * 2, numSegments: 16, offset, rotation }
          : { type: 'capsule', radius: 0.5, height: 2, numSegments: 16, offset, rotation };
        break;
      case 'plane':
        shape = { type: 'plane', offset: [0, 0, 0], rotation };
        break;
      default:
        Logger.error(`Unknown collider shape type '${type}'`);
        return;
    }
    writeShapes(target, [...shapesOf(target), shape]);
  }

  // Hull vertices are baked into the descriptor (and so into the scene) rather than rebuilt on load.
  // They come back centered on their own centroid, which becomes the shape's starting offset.
  const buildHull = (quality: HullQuality): ShapeDescription | null => {
    const positions = collectHullPositions(props.node);
    const hull = positions ? hullFromPositions(positions, quality) : null;
    console.log(`[hull] node='${props.node.name}' quality=${quality} positions=${positions?.length ?? 0} -> ${hull ? `${hull.vertices.length} vertices, ${hull.faces.length} faces` : 'null'}`);
    if (!hull) return null;
    return { type: 'convex', quality, vertices: hull.vertices, faces: hull.faces, offset: hull.center, rotation: [0, 0, 0], v: 5 };
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

  const removeBody = () => { bodies.delete(props.node.id); setBodyProperties(null); eventEmitter.emit('PHYSICS_CHANGED'); eventEmitter.emit('SCENE_CHANGED', { kind: 'physics', node: props.node }); }
  const removeTrigger = () => { triggers.delete(props.node.id); setTriggerProperties(null); eventEmitter.emit('PHYSICS_CHANGED'); eventEmitter.emit('SCENE_CHANGED', { kind: 'physics', node: props.node }); }

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
                  <Button variant='primary' size='sm' onClick={() => setBodyProperties({ mass: 0, linearDamping: 0, angularDamping: 0, linearConstraints: [1, 1, 1], angularConstraints: [1, 1, 1], friction: 0.3, restitution: 0, simulatePhysics: true, cameraCollision: true, groundProbeDistance: 0, shapes: [] })}>Add Rigid Body</Button>
                </>)
          : <>
              {/* The two channels this body takes part in. Independent on purpose: scenery can block
                  the camera without blocking the character, or the reverse. */}
              <Toggle label='Simulate Physics' className='my-1' title={SIMULATE_HINT}
                checked={bodyProperties.simulatePhysics ?? true}
                onChange={(c) => setBodyProperties({ ...bodyProperties, simulatePhysics: c })} />
              <Toggle label='Camera Collision' className='my-1' title={CAMERA_COLLISION_HINT}
                checked={bodyProperties.cameraCollision ?? true}
                onChange={(c) => setBodyProperties({ ...bodyProperties, cameraCollision: c })} />
              <Field label='Mass' labelClassName={LABEL} hint={MASS_HINT}>
                <NumberInput value={bodyProperties.mass} onChange={(v) => setBodyProperties({ ...bodyProperties, mass: v })} />
              </Field>
              <Slider label='Damping' labelClassName={LABEL} min={0} max={1} step={0.01} value={bodyProperties.linearDamping} onChange={(v) => setBodyProperties({ ...bodyProperties, linearDamping: v })} />
              <Slider label='Angular Damping' labelClassName={LABEL} min={0} max={1} step={0.01} value={bodyProperties.angularDamping} onChange={(v) => setBodyProperties({ ...bodyProperties, angularDamping: v })} />
              <Slider label='Friction' labelClassName={LABEL} title={FRICTION_HINT} min={0} max={1} step={0.01} value={bodyProperties.friction ?? 0.3} onChange={(v) => setBodyProperties({ ...bodyProperties, friction: v })} />
              <Slider label='Restitution' labelClassName={LABEL} min={0} max={1} step={0.01} value={bodyProperties.restitution ?? 0} onChange={(v) => setBodyProperties({ ...bodyProperties, restitution: v })} />
              <Slider label='Ground probe' labelClassName={LABEL} title={GROUND_PROBE_HINT} min={0} max={0.5} step={0.01} value={bodyProperties.groundProbeDistance ?? 0} onChange={(v) => setBodyProperties({ ...bodyProperties, groundProbeDistance: v })} />
              {/* Filters the MEASURED motion this body reports — currentSpeed, planarSpeed,
                  planarAcceleration, turnRate. Those are what an animation field's axes and a machine's
                  speed thresholds read, so this slider is the first thing to reach for when a blend
                  vibrates: the noise is in the measurement, not the animation. */}
              <Slider label='Motion smoothing' labelClassName={LABEL} title={MOTION_SMOOTHING_HINT} min={0} max={0.5} step={0.01} value={bodyProperties.motionSmoothing ?? 0} onChange={(v) => setBodyProperties({ ...bodyProperties, motionSmoothing: v })} />
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
    <Collapsable title='Ragdoll' icon={<PhysicsIcon />} persistKey='ragdoll'
      hint='How this skinned mesh simulates when turned into a ragdoll.'>
      <div className='w-full p-2'>
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
