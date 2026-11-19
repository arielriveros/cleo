import { useEffect, useRef, useState } from 'react';
import { ColliderNode, TriggerNode, Node, PHYSICS_SURFACE_PRESETS, hullFromPositions, Logger } from 'cleo'
import type { HullQuality } from 'cleo'
import { useCleoEngine } from '../../EngineContext';
import type { ShapeDescription } from '../../engineContextTypes';
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import ShapeEditor from './ShapeEditor';
import { HULL_QUALITIES } from './hullQuality';
import {
  clampShape, convertShape, duplicateShape, fitShapeToPoints, indexAfterMove, moveShape, newRowKey, reconcileRowKeys,
  removeShapeAt, shapeRowTitle, tidyShape, type PrimitiveShapeType,
} from './shapeListOps';
import { collectHullPositions, hasFitMesh, meshBounds, meshPositions, shapeFitSource } from '../../../utils/editorHelpers';
import {
  COLLISION_SHAPE_FRAME, COLLISION_SHAPES_EDITED, remapCollisionShapeSelection, selectedCollisionShape,
  setCollisionShapeSelection, useCollisionShapeSelection, type CollisionChannel,
} from '../../gizmo/collisionSelection';
import { Field, Slider, Toggle, Select, NumberInput, Button, PresetMenu, Section, Hint, SegmentedControl, DocScope, cn, labelClass } from '@cleo/app-kit/ui'
import { PhysicsIcon, ShapeIcon } from '../sectionIcons'
import { PairInput } from '../propertyEditors/ui2D'
import { LayerMaskSelect, LayerSelect } from './layerPickers'

// The inspectors of the physics nodes: a Collider (a rigid body, and what is under it moves with it) and a
// Trigger (a sensor: shapes in a 3D scene, a box in a 2D one). Each edits its own node, so an edit is an
// ordinary node change -- dirty, and one undo step of the history's snapshot diff -- and the viewport's
// collision handles (CollisionGizmo) write the same `shapes`.

const LABEL = 'w-[130px]';

const SIMULATE_HINT = 'Whether this body takes part in the physics solver. Off makes it a ghost — nothing collides with it, but it can still block a camera rig.';
const FRICTION_HINT = 'Contact friction. At 0 the body is frictionless — nothing will slow it down but damping. What a character wants, since its script sets its own speed.';
const GROUND_PROBE_HINT = 'Counts as grounded while the collider’s feet are within this distance of solid ground, probed every frame. Removes isGrounded flicker (and false falling animations) for a character resting on terrain. Also what makes the groundDistance animation built-in answer. At 0 it is off and grounding comes from solver contacts only — raise it (~0.1–0.2) if a resting character flickers to airborne.';
const CAN_SLEEP_HINT = 'Put the body to sleep once it has stopped moving, until something hits it, pushes it or a script sets its velocity. Saves the cost of props lying still. Off for anything a script steers by writing body.velocity directly.';
const MOTION_SMOOTHING_HINT = 'Time constant for this body’s measured motion — currentSpeed, planarSpeed, acceleration, turn rate. Higher is steadier but slower to react. At 0 the default (~0.09s) applies. Raise it if an animation blend driven by this body’s speed vibrates or jitters; lower it if a script needs a faster answer than it gets.';
const LAYER_HINT = 'The collision layer it is on. Two colliders collide only when each one collides with the other’s layer; camera rigs, foot IK and raycasts pick what they react to by layer too.';
const MASK_HINT = 'The layers it collides with. All on by default.';

// 3 axis toggles (used for linear/angular constraints; value is a [x,y,z] of 0|1).
// Must stay at module scope: a component declared inside a render body is a new type every render, which
// remounts its subtree and wipes the drag state of the vector inputs.
const AxisToggles = ({ label, value, onChange }: { label: string; value: readonly number[]; onChange: (v: [number, number, number]) => void }) => (
  <Field label={label} labelClassName={LABEL}>
    <div className='flex items-center gap-3'>
      {(['X', 'Y', 'Z'] as const).map((ax, i) => (
        <span key={ax} className='inline-flex items-center gap-1'>
          <span className='text-ui-xs text-muted w-2'>{ax}</span>
          <Toggle checked={value[i] === 1} onChange={(c) => { const n = [...value] as [number, number, number]; n[i] = c ? 1 : 0; onChange(n); }} />
        </span>
      ))}
    </div>
  </Field>
);

/**
 * Re-render on the node's edits, the viewport handles' included, and announce one of this panel's: to the
 * helpers and the nav soup (PHYSICS_CHANGED) and to the history and the dirty flag (SCENE_CHANGED).
 */
function usePhysicsNode(node: Node): () => void {
  const { eventEmitter } = useCleoEngine();
  const [, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion(v => v + 1);
    eventEmitter.on('PHYSICS_CHANGED', bump);
    eventEmitter.on(COLLISION_SHAPES_EDITED, bump);
    return () => {
      eventEmitter.off('PHYSICS_CHANGED', bump);
      eventEmitter.off(COLLISION_SHAPES_EDITED, bump);
    };
  }, [node, eventEmitter]);
  // A shape selected on another node is not this panel's to show.
  useEffect(() => {
    const selected = selectedCollisionShape();
    if (selected && selected.nodeId !== node.id) setCollisionShapeSelection(eventEmitter, null);
  }, [node]);
  return () => {
    setVersion(v => v + 1);
    eventEmitter.emit('PHYSICS_CHANGED');
    eventEmitter.emit('SCENE_CHANGED', { kind: 'physics', node });
  };
}

/** What a shape list can do, for {@link ShapeTools}. Indices are positions in that list. */
interface ShapeListApi {
  shapes: ShapeDescription[];
  /** The selected shape's index in this list, or -1. */
  selected: number;
  canHull: boolean;
  canFit: boolean;
  addShape: (type: string) => void;
  addHull: (quality: HullQuality) => boolean;
  regenerateHull: (index: number, quality: HullQuality) => boolean;
  setShape: (index: number, shape: ShapeDescription, field: string) => void;
  select: (index: number) => void;
  frame: (index: number) => void;
  duplicate: (index: number) => void;
  move: (index: number, delta: number) => void;
  convert: (index: number, type: PrimitiveShapeType) => void;
  fit: (index: number) => void;
  remove: (index: number) => void;
}

/**
 * The shape list of a Collider or a 3D Trigger. New and fitted shapes take the meshes under the node
 * (a Trigger without any, the node it is under: see shapeFitSource), in the node's own units -- the space
 * shapes are authored in, which its world scale scales.
 */
function useShapeList(owner: ColliderNode | TriggerNode, channel: CollisionChannel, changed: () => void): ShapeListApi {
  const { eventEmitter } = useCleoEngine();
  const selection = useCollisionShapeSelection(eventEmitter);
  const shapes = owner.shapes as ShapeDescription[];
  const id = owner.id;
  // The vertex gathering itself happens fresh on each action, so edits made after selection still count.
  const source = shapeFitSource(owner);
  const canHull = hasFitMesh(source, false);
  const canFit = hasFitMesh(source, true);

  const write = (next: ShapeDescription[]) => { owner.shapes = next as any; changed(); };
  const select = (index: number | null) =>
    setCollisionShapeSelection(eventEmitter, index === null ? null : { nodeId: id, channel, index });

  const addShape = (type: string) => {
    const b = meshBounds(source, owner);
    const offset = b ? [b.center[0], b.center[1], b.center[2]] : [0, 0, 0];
    const rotation = [0, 0, 0];
    let shape: ShapeDescription;
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
        // the character. The floor keeps a zero radius from reaching the solver.
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
    write([...shapes, tidyShape(clampShape(shape))]);
    select(shapes.length);
  };

  // Hull vertices are baked into the descriptor (and so into the scene) rather than rebuilt on load.
  // They come back centred on their own centroid, which becomes the shape's starting offset.
  const buildHull = (quality: HullQuality): ShapeDescription | null => {
    const positions = collectHullPositions(source, owner);
    const hull = positions ? hullFromPositions(positions, quality) : null;
    if (!hull) return null;
    return { type: 'convex', quality, vertices: hull.vertices, faces: hull.faces, offset: hull.center, rotation: [0, 0, 0], v: 5 };
  };

  return {
    shapes,
    selected: selection && selection.nodeId === id && selection.channel === channel ? selection.index : -1,
    canHull,
    canFit,
    addShape,
    addHull: (quality) => {
      const shape = buildHull(quality);
      if (!shape) return false;
      write([...shapes, shape]);
      select(shapes.length);
      return true;
    },
    regenerateHull: (index, quality) => {
      const shape = buildHull(quality);
      if (!shape) return false;
      const next = [...shapes];
      next[index] = { ...shape, rotation: shapes[index].rotation }; // a manual re-orientation survives
      write(next);
      return true;
    },
    setShape: (i, s) => { const next = [...shapes]; next[i] = clampShape(s); write(next); },
    select: (i) => select(i),
    frame: (i) => { select(i); eventEmitter.emit(COLLISION_SHAPE_FRAME, { nodeId: id, channel, index: i }); },
    duplicate: (i) => { write(duplicateShape(shapes, i)); select(i + 1); },
    move: (i, delta) => {
      const moved = moveShape(shapes, i, delta);
      write(moved.shapes);
      remapCollisionShapeSelection(eventEmitter, id, channel, k => indexAfterMove(k, i, moved.index));
    },
    convert: (i, t) => { const next = [...shapes]; next[i] = convertShape(shapes[i], t); write(next); },
    fit: (i) => { const next = [...shapes]; next[i] = fitShapeToPoints(shapes[i], meshPositions(source, owner)); write(next); },
    remove: (i) => {
      write(removeShapeAt(shapes, i));
      remapCollisionShapeSelection(eventEmitter, id, channel, k => (k === i ? null : k > i ? k - 1 : k));
    },
  };
}

/**
 * Shape list plus the add-shape row. `canHull` is true when there is static mesh geometry to fit a convex
 * hull to; skinned meshes do not qualify.
 *
 * Row keys and open/closed state are this component's own and follow the shapes through a duplicate,
 * move or removal, so a field being typed into is never handed to the shape that slid into its place.
 */
const ShapeTools = (api: ShapeListApi) => {
  const [quality, setQuality] = useState<HullQuality>('medium');
  const [degenerate, setDegenerate] = useState(false);
  const keysRef = useRef<string[]>([]);
  keysRef.current = reconcileRowKeys(keysRef.current, api.shapes.length);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const keys = keysRef.current;

  const toggle = (key: string) => setClosed(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const duplicate = (i: number) => { keysRef.current = [...keys.slice(0, i + 1), newRowKey(), ...keys.slice(i + 1)]; api.duplicate(i); };
  const remove = (i: number) => { keysRef.current = keys.filter((_, k) => k !== i); api.remove(i); };
  const move = (i: number, delta: number) => {
    const to = Math.min(keys.length - 1, Math.max(0, i + delta));
    const next = [...keys];
    next.splice(to, 0, next.splice(i, 1)[0]);
    keysRef.current = next;
    api.move(i, delta);
  };

  return (
    <Section title='Shapes'>
      <div className='flex items-center gap-1.5 flex-wrap mb-2'>
        <span className={cn(labelClass, 'mr-1')}>Add:</span>
        {['box', 'sphere', 'capsule', 'cylinder', 'plane'].map((t) => (
          <Button key={t} size='sm' onClick={() => api.addShape(t)}>{t.charAt(0).toUpperCase() + t.slice(1)}</Button>
        ))}
      </div>

      { api.canHull && <div className='mb-3'>
        <Field label='Hull Definition' labelClassName='w-[100px]'>
          <SegmentedControl size='sm' grow options={HULL_QUALITIES} value={quality} onChange={(v) => setQuality(v as HullQuality)} />
        </Field>
        <Button size='sm' className='mt-1.5' onClick={() => setDegenerate(!api.addHull(quality))}>Add Convex Hull</Button>
        { degenerate && <Hint className='mt-1'>This mesh is flat or has too few vertices to form a hull.</Hint> }
      </div> }

      { api.shapes.length === 0 && <Hint className='mb-2'>No shapes: nothing collides with it yet.</Hint> }

      {api.shapes.map((shape, i) => (
        <ShapeEditor
          key={keys[i]}
          shape={shape}
          title={shapeRowTitle(shape, i)}
          selected={api.selected === i}
          // The selected row is always open: it is what the viewport handles are editing.
          open={api.selected === i || !closed.has(keys[i])}
          onToggleOpen={() => toggle(keys[i])}
          setShape={(s, field) => api.setShape(i, s, field)}
          actions={{
            select: () => api.select(i),
            frame: () => api.frame(i),
            duplicate: () => duplicate(i),
            remove: () => remove(i),
            moveUp: i > 0 ? () => move(i, -1) : undefined,
            moveDown: i < api.shapes.length - 1 ? () => move(i, 1) : undefined,
            convert: (t) => api.convert(i, t),
            fit: api.canFit && shape.type !== 'plane' && shape.type !== 'convex' ? () => api.fit(i) : undefined,
            regenerateHull: api.canHull ? (q) => api.regenerateHull(i, q) : undefined,
          }}
        />
      ))}
    </Section>
  );
};

/** A Collider: the rigid body, its layers, and its shapes. */
export function ColliderEditor({ node }: { node: ColliderNode }) {
  const { projectSettings } = useCleoEngine();
  const changed = usePhysicsNode(node);
  const list = useShapeList(node, 'body', changed);
  const set = <K extends keyof ColliderNode>(key: K, value: ColliderNode[K]) => { node[key] = value; changed(); };
  const character = node.children.some(c => c.nodeType === 'character');
  const range = projectSettings.engine.simulationRange;

  return (
    <DocScope page='editor/physics'>
      <Collapsable title='Collider' icon={<PhysicsIcon />} badge={node.shapes.length || undefined} persistKey='node.collider' defaultOpen
        right={<PresetMenu label='Surface' presets={PHYSICS_SURFACE_PRESETS}
          title='What the body is made of — friction and bounce only'
          onApply={(p) => { Object.assign(node, p.options); changed(); }} />}>
        <div className='w-full p-2'>
          {character
            ? <Hint className='mb-2'>The Character under it walks this body: give it a capsule, and freeze its rotation.</Hint>
            : <Hint className='mb-2'>Everything under it moves with it: with mass it falls, and they fall too.</Hint>}
          {/* Whether the solver sees it. What a camera rig does with it is the rig's choice, by this body's Layer. */}
          <Toggle label='Simulate Physics' className='my-1' title={SIMULATE_HINT}
            checked={node.simulatePhysics} onChange={(c) => set('simulatePhysics', c)} />
          <Field label='Mass' labelClassName={LABEL} hint='0: static, or moved by hand. Above 0 it falls and is pushed.'>
            <NumberInput value={node.mass} min={0} onChange={(v) => set('mass', Math.max(0, v))} />
          </Field>
          <Slider label='Damping' labelClassName={LABEL} min={0} max={1} step={0.01} value={node.linearDamping} onChange={(v) => set('linearDamping', v)} />
          <Slider label='Angular Damping' labelClassName={LABEL} min={0} max={1} step={0.01} value={node.angularDamping} onChange={(v) => set('angularDamping', v)} />
          <Slider label='Friction' labelClassName={LABEL} title={FRICTION_HINT} min={0} max={1} step={0.01} value={node.friction} onChange={(v) => set('friction', v)} />
          <Slider label='Restitution' labelClassName={LABEL} min={0} max={1} step={0.01} value={node.restitution} onChange={(v) => set('restitution', v)} />
          <Slider label='Ground probe' labelClassName={LABEL} title={GROUND_PROBE_HINT} min={0} max={0.5} step={0.01} value={node.groundProbeDistance} onChange={(v) => set('groundProbeDistance', v)} />
          {/* Filters the MEASURED motion this body reports — currentSpeed, planarSpeed, planarAcceleration,
              turnRate. Those are what an animation field's axes and a machine's speed thresholds read, so
              this slider is the first thing to reach for when a blend vibrates. */}
          <Slider label='Motion smoothing' labelClassName={LABEL} title={MOTION_SMOOTHING_HINT} min={0} max={0.5} step={0.01} value={node.motionSmoothing} onChange={(v) => set('motionSmoothing', v)} />
          <LayerSelect label='Layer' labelClassName={LABEL} hint={LAYER_HINT} value={node.layer} onChange={(v) => set('layer', v)} />
          <LayerMaskSelect label='Collides with' labelClassName={LABEL} hint={MASK_HINT} value={node.mask} onChange={(v) => set('mask', v)} />
          {/* Freeze-in-place out of range, and sleep at rest: what keeps a large level's far props free. */}
          <Field label='Simulation' labelClassName={LABEL}>
            <Select value={node.simulationMode}
              onChange={(e) => set('simulationMode', e.target.value as ColliderNode['simulationMode'])}>
              <option value='project'>{`Project range (${range > 0 ? `${range} m` : 'unlimited'})`}</option>
              <option value='always'>Always</option>
              <option value='custom'>Custom range</option>
            </Select>
          </Field>
          {node.simulationMode === 'custom' &&
            <Field label='Range (m)' labelClassName={LABEL} hint='Metres from the camera past which this body freezes. 0 = unlimited.'>
              <NumberInput value={node.simulationRange} min={0} step={5} onChange={(v) => set('simulationRange', Math.max(0, v))} />
            </Field>}
          <Toggle label='Sleep when resting' className='my-1' title={CAN_SLEEP_HINT}
            checked={node.canSleep} onChange={(c) => set('canSleep', c)} />
          <AxisToggles label='Linear Constraints' value={node.linearConstraints} onChange={(v) => set('linearConstraints', v)} />
          <AxisToggles label='Angular Constraints' value={node.angularConstraints} onChange={(v) => set('angularConstraints', v)} />
          <div className='mt-2'>
            <ShapeTools {...list} />
          </div>
        </div>
      </Collapsable>
    </DocScope>
  );
}

/**
 * A Trigger: a sensor. In a 3D scene it is its shapes; in a 2D scene a box (size and offset), which 2D
 * bodies, colliders and other triggers are seen in. Its events fire on it, and on what came in.
 */
export function TriggerEditor({ node }: { node: TriggerNode }) {
  const { sceneDimension } = useCleoEngine();
  const changed = usePhysicsNode(node);
  const is2D = node.scene ? node.is2D : sceneDimension === '2D';
  const list = useShapeList(node, 'trigger', changed);
  const set = <K extends keyof TriggerNode>(key: K, value: TriggerNode[K]) => { (node as any)[key] = value; changed(); };

  return (
    <DocScope page={is2D ? 'editor/tilemap-2d' : 'editor/physics'}>
      <Collapsable title='Trigger' icon={<ShapeIcon />} badge={!is2D && node.shapes.length || undefined} persistKey='node.trigger' defaultOpen>
        <div className='w-full p-2'>
          <Toggle label='Enabled' className='my-1' checked={node.enabled} onChange={(c) => set('enabled', c)} />
          {is2D && <>
            <Field label='Size' labelClassName={LABEL} hint='Width and height, world units, centred on the node.'>
              <PairInput min={0} value={node.size} onChange={(v) => set('size', v)} />
            </Field>
            <Field label='Offset' labelClassName={LABEL} hint='From the node, mirrored when the character it rides on faces left.'>
              <PairInput value={node.offset} onChange={(v) => set('offset', v)} />
            </Field>
          </>}
          {/* The project's collision layers, one set for 2D and 3D. */}
          <LayerSelect label='Layer' labelClassName={LABEL} hint='The layer it is on, which another trigger must look for to see it.' value={node.layer} onChange={(v) => set('layer', v)} />
          <LayerMaskSelect label='Detects' labelClassName={LABEL} hint='The layers it sees bodies and colliders on.' value={node.mask} onChange={(v) => set('mask', v)} />
          <Toggle label='Detect triggers' className='my-1' title='Also see other triggers: a sword’s hitbox seeing a hurtbox.'
            checked={node.detectTriggers} onChange={(c) => set('detectTriggers', c)} />
          {!is2D && node.detectTriggers &&
            <Toggle label='Continuous' className='my-1' title='Test its path between frames against other triggers: a fast blade.'
              checked={node.continuous} onChange={(c) => set('continuous', c)} />}
          {!is2D && <div className='mt-2'><ShapeTools {...list} /></div>}
          <Hint className='mt-2'>Scripts hear onTriggerEnter / onTriggerExit on the trigger, and on what came in.</Hint>
        </div>
      </Collapsable>
    </DocScope>
  );
}
