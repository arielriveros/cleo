import { useEffect, useMemo, useRef, useState } from 'react';
import { ModelNode, AnimatedModel, Node, RAGDOLL_DEFAULTS, PHYSICS_SURFACE_PRESETS, hullFromPositions, Logger, effectiveRagdollProfile } from 'cleo'
import type { RagdollOptions, HullQuality } from 'cleo'
import { BodyDescription, ShapeDescription, useCleoEngine } from '../../EngineContext';
import { useHistory } from '../../HistoryContext';
import Collapsable from '../../../components/Collapsable'
import AxisInput from '../../../components/AxisInput'
import ShapeEditor from './ShapeEditor';
import { HULL_QUALITIES } from './hullQuality';
import {
  clampShape, convertShape, duplicateShape, fitShapeToPoints, indexAfterMove, moveShape, newRowKey, reconcileRowKeys,
  removeShapeAt, shapeRowTitle, cloneShape, tidyShape, type PrimitiveShapeType,
} from './shapeListOps';
import { collectHullPositions, meshBounds, meshPositions } from '../../../utils/editorHelpers';
import {
  COLLISION_SHAPE_FRAME, COLLISION_SHAPES_EDITED, remapCollisionShapeSelection, setCollisionShapeSelection,
  useCollisionShapeSelection, type CollisionChannel,
} from '../../gizmo/collisionSelection';
import { Field, Slider, Toggle, Select, NumberInput, Button, PresetMenu, Section, Hint, SegmentedControl, DocScope, cn, labelClass, valueClass } from '../../../components/ui'
import { PhysicsIcon, ShapeIcon } from '../sectionIcons'
import { useAssetLibrary } from '../../AssetLibraryContext'
import { modelIdOf } from '../../../utils/models'

const LABEL = 'w-[130px]';

/** The names the docs' Ragdoll › Source table gives the three ragdolls a character can fall with. */
const RAGDOLL_SOURCE_LABEL = { rig: 'Rig profile', auto: 'Automatic humanoid', generic: 'Generic' } as const;

const SIMULATE_HINT = 'Whether this body takes part in the physics solver. Off makes it a ghost — nothing collides with it, but it can still block a camera rig.';
const CAMERA_COLLISION_HINT = 'Whether camera rigs collide with this body. Off and they pass straight through it. Independent of Simulate Physics on purpose: scenery can block the camera without blocking the character, or the reverse.';
const FRICTION_HINT = 'Contact friction. At 0 the body is frictionless — nothing will slow it down but damping. What a character wants, since its script sets its own speed.';
const GROUND_PROBE_HINT = 'Counts as grounded while the collider’s feet are within this distance of solid ground, probed every frame. Removes isGrounded flicker (and false falling animations) for a character resting on terrain. Also what makes the groundDistance animation built-in answer. At 0 it is off and grounding comes from solver contacts only — raise it (~0.1–0.2) if a resting character flickers to airborne.';
const CAN_SLEEP_HINT = 'Put the body to sleep once it has stopped moving, until something hits it, pushes it or a script sets its velocity. Saves the cost of props lying still. Off for anything a script steers by writing body.velocity directly.';
const MOTION_SMOOTHING_HINT = 'Time constant for this body’s measured motion — currentSpeed, planarSpeed, acceleration, turn rate. Higher is steadier but slower to react. At 0 the default (~0.09s) applies. Raise it if an animation blend driven by this body’s speed vibrates or jitters; lower it if a script needs a faster answer than it gets.';

const NEW_BODY: BodyDescription = { mass: 0, linearDamping: 0, angularDamping: 0, linearConstraints: [1, 1, 1], angularConstraints: [1, 1, 1], friction: 0.3, restitution: 0, simulatePhysics: true, cameraCollision: true, groundProbeDistance: 0, simulationMode: 'project', simulationRange: 0, canSleep: false, shapes: [] };

/** The body as the panel shows it: every optional field resolved to what the engine applies when absent. */
function withBodyDefaults(body: BodyDescription): BodyDescription {
  return {
    ...body,
    friction: body.friction ?? 0.3,
    restitution: body.restitution ?? 0,
    simulatePhysics: body.simulatePhysics ?? true,
    cameraCollision: body.cameraCollision ?? true,
    // 0 = ground probe off.
    groundProbeDistance: body.groundProbeDistance ?? 0,
    // 0 means "use the engine default (~0.09s)".
    motionSmoothing: body.motionSmoothing ?? 0,
    // Absent in bodies authored before simulation range: the project's range, no resting sleep.
    simulationMode: body.simulationMode ?? 'project',
    simulationRange: body.simulationRange ?? 0,
    canSleep: body.canSleep ?? false,
  };
}

// 3 axis toggles (used for linear/angular constraints; value is a [x,y,z] of 0|1).
// Must stay at module scope: a component declared inside a render body is a new type every render, which
// remounts its subtree and wipes the drag state of the vector inputs.
const AxisToggles = ({ label, value, onChange }: { label: string; value: number[]; onChange: (v: number[]) => void }) => (
  <Field label={label} labelClassName={LABEL}>
    <div className='flex items-center gap-3'>
      {(['X', 'Y', 'Z'] as const).map((ax, i) => (
        <span key={ax} className='inline-flex items-center gap-1'>
          <span className='text-ui-xs text-muted w-2'>{ax}</span>
          <Toggle checked={value[i] === 1} onChange={(c) => { const n = [...value]; n[i] = c ? 1 : 0; onChange(n); }} />
        </span>
      ))}
    </div>
  </Field>
);

/** What a channel's shape list can do, for {@link ShapeTools}. Indices are positions in that list. */
interface ShapeListApi {
  shapes: ShapeDescription[];
  /** The selected shape's index in this list, or -1. */
  selected: number;
  canHull: boolean;
  canFit: boolean;
  /** The other channel's name when a shape can be copied there, or null. */
  copyTarget: string | null;
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
  copy: (index: number) => void;
  remove: (index: number) => void;
}

/**
 * Shape list plus the add-shape row. `canHull` is true when the node subtree has static mesh geometry
 * to fit a convex hull to; skinned meshes do not qualify.
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
            copy: api.copyTarget ? { label: `Copy to ${api.copyTarget}`, run: () => api.copy(i) } : undefined,
            regenerateHull: api.canHull ? (q) => api.regenerateHull(i, q) : undefined,
          }}
        />
      ))}
    </Section>
  );
};

export default function PhysicsEditor(props: {node: Node}) {
  const { bodies, triggers, eventEmitter, enterRigEditor, projectSettings } = useCleoEngine();
  const { push } = useHistory();
  const [bodyProperties, setBodyProperties] = useState<BodyDescription | null>(null)
  const [triggerProperties, setTriggerProperties] = useState<{shapes: ShapeDescription[]} | null>(null);
  const [ragdoll, setRagdoll] = useState<RagdollOptions | null>(null);
  const [sceneChanged, setSceneChanged] = useState(false);
  const selection = useCollisionShapeSelection(eventEmitter);

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

  // ------------------------------------------------------------------------------------------------
  // The shared maps are the truth; the panel only shows them
  // ------------------------------------------------------------------------------------------------
  //
  // The bodies/triggers maps have three writers: this panel, the viewport's collision handles, and undo.
  // The panel used to keep its own copy and write it back from an effect, so after a handle drag (or an
  // undo of one) it still held the old shapes, and its next edit — even the mass — put them back. Now
  // every write goes to the map first and the panel re-reads it on PHYSICS_CHANGED; the refs remember the
  // record (and its shapes array: the hull migration replaces only that) last shown, to skip no-op reads.
  const shownBodyRef = useRef<{ record?: BodyDescription; shapes?: ShapeDescription[] }>({});
  const shownTriggerRef = useRef<{ record?: { shapes: ShapeDescription[] }; shapes?: ShapeDescription[] }>({});

  useEffect(() => {
    const sync = (force: boolean) => {
      const body = bodies.get(props.node.id);
      if (force || body !== shownBodyRef.current.record || body?.shapes !== shownBodyRef.current.shapes) {
        shownBodyRef.current = { record: body, shapes: body?.shapes };
        setBodyProperties(body ? withBodyDefaults(body) : null);
      }
      const trigger = triggers.get(props.node.id);
      if (force || trigger !== shownTriggerRef.current.record || trigger?.shapes !== shownTriggerRef.current.shapes) {
        shownTriggerRef.current = { record: trigger, shapes: trigger?.shapes };
        setTriggerProperties(trigger ? { shapes: trigger.shapes } : null);
      }
    };
    sync(true);
    const onChange = () => sync(false);
    eventEmitter.on('PHYSICS_CHANGED', onChange);
    eventEmitter.on(COLLISION_SHAPES_EDITED, onChange);
    return () => {
      eventEmitter.off('PHYSICS_CHANGED', onChange);
      eventEmitter.off(COLLISION_SHAPES_EDITED, onChange);
    };
  }, [props.node, bodies, triggers, eventEmitter]);

  // A shape selected on another node is not this panel's to show.
  useEffect(() => {
    if (selection && selection.nodeId !== props.node.id) setCollisionShapeSelection(eventEmitter, null);
  }, [props.node]);

  /** Tell the helpers, the navmesh soup and the tab's dirty flag. */
  const announce = (node: Node) => {
    eventEmitter.emit('PHYSICS_CHANGED');
    eventEmitter.emit('SCENE_CHANGED', { kind: 'physics', node });
  };

  /**
   * Replace one channel's record (null removes it) as ONE undo step. Bodies and triggers live outside
   * `node.serialize()`, so the history's snapshot diff never sees them: the step is built here instead.
   * `coalesce` names the field being edited, so a slider scrub or a typed number is one step, not fifty.
   */
  const commit = (channel: CollisionChannel, next: BodyDescription | { shapes: ShapeDescription[] } | null, label: string, coalesce?: string) => {
    const node = props.node;
    const map = (channel === 'body' ? bodies : triggers) as Map<string, any>;
    const before = map.get(node.id) ?? null;
    const write = (record: typeof before) => { if (record) map.set(node.id, record); else map.delete(node.id); announce(node); };
    write(next);
    push({
      label,
      ...(coalesce ? { coalesceKey: `physics:${node.id}:${channel}:${coalesce}` } : {}),
      undo: () => write(before),
      redo: () => write(next),
    });
  };

  const setBody = (patch: Partial<BodyDescription>) =>
    commit('body', { ...bodyProperties!, ...patch }, 'Rigid body', Object.keys(patch).join(','));

  useEffect(() => {
    const m = props.node as ModelNode;
    const skinned = props.node.nodeType === 'model' && m.model instanceof AnimatedModel && m.model.hasSkin && !!m.animator;
    if (skinned) setRagdoll({ ...RAGDOLL_DEFAULTS, ...(m.ragdollConfig || {}) });
    else setRagdoll(null);
  }, [props.node]);

  // Ragdoll config lives on the node itself, so it serializes with the scene. An edit is a scene change
  // (dirty + undo); adopting the node's config on selection is not.
  const ragdollLoadRef = useRef(true);
  useEffect(() => { ragdollLoadRef.current = true; }, [props.node]);
  useEffect(() => {
    if (!ragdoll || !isSkinned) return;
    (props.node as ModelNode).ragdollConfig = ragdoll;
    if (ragdollLoadRef.current) ragdollLoadRef.current = false;
    else eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node });
  }, [ragdoll]);
  // What this character falls with: the rig's authored profile, the automatic humanoid one, or the
  // generic per-bone ragdoll. Only the last is tuned by the joint fields below.
  const { models: modelLibrary } = useAssetLibrary();
  const ragdollSource = useMemo(() => {
    const m = props.node as ModelNode;
    const skin = m.model instanceof AnimatedModel ? m.model.skin : null;
    return skin ? effectiveRagdollProfile(skin).source : 'generic';
  }, [props.node, sceneChanged]);
  const ragdollRigId = modelLibrary.find(m => m.id === modelIdOf(props.node))?.rigId;

  // The vertex gathering itself happens fresh on click, so child edits made after selection still count.
  const canHull = useMemo(() => collectHullPositions(props.node) !== null, [props.node, sceneChanged]);
  const canFit = useMemo(() => meshBounds(props.node) !== null, [props.node, sceneChanged]);

  // ------------------------------------------------------------------------------------------------
  // Shape lists
  // ------------------------------------------------------------------------------------------------

  const shapesOf = (channel: CollisionChannel): ShapeDescription[] =>
    (channel === 'body' ? bodyProperties?.shapes : triggerProperties?.shapes) ?? [];

  const writeShapes = (channel: CollisionChannel, shapes: ShapeDescription[], label: string, coalesce?: string) =>
    commit(channel, channel === 'body' ? { ...bodyProperties!, shapes } : { shapes }, label, coalesce);

  const shapeLabel = (channel: CollisionChannel, verb: string) => `${verb} ${channel === 'body' ? 'body' : 'trigger'} shape`;

  const select = (channel: CollisionChannel, index: number | null) =>
    setCollisionShapeSelection(eventEmitter, index === null ? null : { nodeId: props.node.id, channel, index });

  /**
   * Adds a shape fitted to the node's mesh and its descendants'. `meshBounds` works in node-local units —
   * the space shape descriptors are authored in — and includes skinned meshes. A mesh-less node keeps the
   * unit defaults. The new shape is selected, so its handles are up in the viewport straight away.
   */
  const addShape = (type: string, channel: CollisionChannel) => {
    const b = meshBounds(props.node);
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
    const shapes = shapesOf(channel);
    writeShapes(channel, [...shapes, tidyShape(clampShape(shape))], shapeLabel(channel, 'Add'));
    select(channel, shapes.length);
  }

  // Hull vertices are baked into the descriptor (and so into the scene) rather than rebuilt on load.
  // They come back centered on their own centroid, which becomes the shape's starting offset.
  const buildHull = (quality: HullQuality): ShapeDescription | null => {
    const positions = collectHullPositions(props.node);
    const hull = positions ? hullFromPositions(positions, quality) : null;
    if (!hull) return null;
    return { type: 'convex', quality, vertices: hull.vertices, faces: hull.faces, offset: hull.center, rotation: [0, 0, 0], v: 5 };
  };

  const addHull = (channel: CollisionChannel, quality: HullQuality): boolean => {
    const shape = buildHull(quality);
    if (!shape) return false;
    const shapes = shapesOf(channel);
    writeShapes(channel, [...shapes, shape], shapeLabel(channel, 'Add'));
    select(channel, shapes.length);
    return true;
  };

  const regenerateHull = (channel: CollisionChannel, index: number, quality: HullQuality): boolean => {
    const shape = buildHull(quality);
    if (!shape) return false;
    const shapes = [...shapesOf(channel)];
    shapes[index] = { ...shape, rotation: shapes[index].rotation }; // a manual re-orientation survives
    writeShapes(channel, shapes, shapeLabel(channel, 'Rebuild'));
    return true;
  };

  /** The other channel, when a shape can be copied into it: a trigger always (one is added if need be),
   *  a body only where one already is — whether a node may HAVE a body is the Add button's question. */
  const copyTarget = (channel: CollisionChannel): string | null =>
    channel === 'body' ? 'trigger' : (bodyProperties ? 'rigid body' : null);

  const copyShape = (channel: CollisionChannel, index: number) => {
    const to: CollisionChannel = channel === 'body' ? 'trigger' : 'body';
    const copy = cloneShape(shapesOf(channel)[index]);
    const target = to === 'body'
      ? { ...bodyProperties!, shapes: [...bodyProperties!.shapes, copy] }
      : { shapes: [...(triggerProperties?.shapes ?? []), copy] };
    commit(to, target, `Copy shape to ${to === 'body' ? 'body' : 'trigger'}`);
  };

  const listApi = (channel: CollisionChannel): ShapeListApi => {
    const shapes = shapesOf(channel);
    const id = props.node.id;
    return {
      shapes,
      selected: selection && selection.nodeId === id && selection.channel === channel ? selection.index : -1,
      canHull,
      canFit,
      copyTarget: copyTarget(channel),
      addShape: (t) => addShape(t, channel),
      addHull: (q) => addHull(channel, q),
      regenerateHull: (i, q) => regenerateHull(channel, i, q),
      setShape: (i, s, field) => {
        const next = [...shapes]; next[i] = clampShape(s);
        writeShapes(channel, next, shapeLabel(channel, 'Edit'), `shape${i}:${field}`);
      },
      select: (i) => select(channel, i),
      frame: (i) => { select(channel, i); eventEmitter.emit(COLLISION_SHAPE_FRAME, { nodeId: id, channel, index: i }); },
      duplicate: (i) => {
        writeShapes(channel, duplicateShape(shapes, i), shapeLabel(channel, 'Duplicate'));
        select(channel, i + 1);
      },
      move: (i, delta) => {
        const moved = moveShape(shapes, i, delta);
        writeShapes(channel, moved.shapes, shapeLabel(channel, 'Reorder'));
        remapCollisionShapeSelection(eventEmitter, id, channel, k => indexAfterMove(k, i, moved.index));
      },
      convert: (i, t) => {
        const next = [...shapes]; next[i] = convertShape(shapes[i], t);
        writeShapes(channel, next, shapeLabel(channel, 'Convert'));
      },
      fit: (i) => {
        const next = [...shapes]; next[i] = fitShapeToPoints(shapes[i], meshPositions(props.node));
        writeShapes(channel, next, shapeLabel(channel, 'Fit'));
      },
      copy: (i) => copyShape(channel, i),
      remove: (i) => {
        writeShapes(channel, removeShapeAt(shapes, i), shapeLabel(channel, 'Remove'));
        remapCollisionShapeSelection(eventEmitter, id, channel, k => (k === i ? null : k > i ? k - 1 : k));
      },
    };
  };

  const removeBody = () => {
    remapCollisionShapeSelection(eventEmitter, props.node.id, 'body', () => null);
    commit('body', null, 'Remove rigid body');
  };
  const removeTrigger = () => {
    remapCollisionShapeSelection(eventEmitter, props.node.id, 'trigger', () => null);
    commit('trigger', null, 'Remove trigger');
  };

  const shapeTools = (channel: CollisionChannel) => <ShapeTools {...listApi(channel)} />;

  return ( <DocScope page='editor/physics'>
    <Collapsable title='Rigid Body' icon={<PhysicsIcon />} badge={bodyProperties?.shapes.length || undefined} persistKey='rigidBody'
      right={bodyProperties && <PresetMenu label='Surface' presets={PHYSICS_SURFACE_PRESETS}
        title='What the body is made of — friction and bounce only'
        onApply={(p) => commit('body', { ...bodyProperties, ...p.options }, 'Surface preset')} />}>
      <div className='w-full p-2'>
        { !bodyProperties ?
          (props.node.name === 'root'
            ? <Hint>Root node cannot have a rigid body.</Hint>
            : props.node.parent?.name !== 'root'
              ? <Hint>Can only add rigid bodies to nodes at root level.</Hint>
              : <>
                  <Hint className='mb-2'>Node does not have a rigid body.</Hint>
                  <Button variant='primary' size='sm' onClick={() => commit('body', { ...NEW_BODY, shapes: [] }, 'Add rigid body')}>Add Rigid Body</Button>
                </>)
          : <>
              {/* The two channels this body takes part in. Independent on purpose: scenery can block
                  the camera without blocking the character, or the reverse. */}
              <Toggle label='Simulate Physics' className='my-1' title={SIMULATE_HINT}
                checked={bodyProperties.simulatePhysics ?? true}
                onChange={(c) => setBody({ simulatePhysics: c })} />
              <Toggle label='Camera Collision' className='my-1' title={CAMERA_COLLISION_HINT}
                checked={bodyProperties.cameraCollision ?? true}
                onChange={(c) => setBody({ cameraCollision: c })} />
              <Field label='Mass' labelClassName={LABEL}>
                <NumberInput value={bodyProperties.mass} onChange={(v) => setBody({ mass: v })} />
              </Field>
              <Slider label='Damping' labelClassName={LABEL} min={0} max={1} step={0.01} value={bodyProperties.linearDamping} onChange={(v) => setBody({ linearDamping: v })} />
              <Slider label='Angular Damping' labelClassName={LABEL} min={0} max={1} step={0.01} value={bodyProperties.angularDamping} onChange={(v) => setBody({ angularDamping: v })} />
              <Slider label='Friction' labelClassName={LABEL} title={FRICTION_HINT} min={0} max={1} step={0.01} value={bodyProperties.friction ?? 0.3} onChange={(v) => setBody({ friction: v })} />
              <Slider label='Restitution' labelClassName={LABEL} min={0} max={1} step={0.01} value={bodyProperties.restitution ?? 0} onChange={(v) => setBody({ restitution: v })} />
              <Slider label='Ground probe' labelClassName={LABEL} title={GROUND_PROBE_HINT} min={0} max={0.5} step={0.01} value={bodyProperties.groundProbeDistance ?? 0} onChange={(v) => setBody({ groundProbeDistance: v })} />
              {/* Filters the MEASURED motion this body reports — currentSpeed, planarSpeed,
                  planarAcceleration, turnRate. Those are what an animation field's axes and a machine's
                  speed thresholds read, so this slider is the first thing to reach for when a blend
                  vibrates: the noise is in the measurement, not the animation. */}
              <Slider label='Motion smoothing' labelClassName={LABEL} title={MOTION_SMOOTHING_HINT} min={0} max={0.5} step={0.01} value={bodyProperties.motionSmoothing ?? 0} onChange={(v) => setBody({ motionSmoothing: v })} />
              {/* Freeze-in-place out of range, and sleep at rest: what keeps a large level's far props free. */}
              <Field label='Simulation' labelClassName={LABEL}>
                <Select value={bodyProperties.simulationMode ?? 'project'}
                  onChange={(e) => setBody({ simulationMode: e.target.value as 'project' | 'always' | 'custom' })}>
                  <option value='project'>{`Project range (${projectSettings.engine.simulationRange > 0 ? `${projectSettings.engine.simulationRange} m` : 'unlimited'})`}</option>
                  <option value='always'>Always</option>
                  <option value='custom'>Custom range</option>
                </Select>
              </Field>
              {bodyProperties.simulationMode === 'custom' &&
                <Field label='Range (m)' labelClassName={LABEL} hint='Metres from the camera past which this body freezes. 0 = unlimited.'>
                  <NumberInput value={bodyProperties.simulationRange ?? 0} min={0} step={5}
                    onChange={(v) => setBody({ simulationRange: Math.max(0, v) })} />
                </Field>}
              <Toggle label='Sleep when resting' className='my-1' title={CAN_SLEEP_HINT}
                checked={bodyProperties.canSleep ?? false}
                onChange={(c) => setBody({ canSleep: c })} />
              <AxisToggles label='Linear Constraints' value={bodyProperties.linearConstraints} onChange={(v) => setBody({ linearConstraints: v as [number, number, number] })} />
              <AxisToggles label='Angular Constraints' value={bodyProperties.angularConstraints} onChange={(v) => setBody({ angularConstraints: v as [number, number, number] })} />
              <Button variant='danger' size='sm' className='mt-2' onClick={removeBody}>Remove Rigid Body</Button>
              <div className='mt-2'>
                {shapeTools('body')}
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
              <Button variant='primary' size='sm' onClick={() => commit('trigger', { shapes: [] }, 'Add trigger')}>Add Trigger</Button>
            </>
          : <>
              <Button variant='danger' size='sm' onClick={removeTrigger}>Remove Trigger</Button>
              <div className='mt-2'>
                {shapeTools('trigger')}
              </div>
            </>
        }
      </div>
    </Collapsable>

    { isSkinned && ragdoll &&
    <Collapsable title='Ragdoll' icon={<PhysicsIcon />} persistKey='ragdoll'>
      <div className='w-full p-2'>
        {/* Which of the three ragdolls this character falls with: the fields below change with it. */}
        <Field label='Source' labelClassName={LABEL}>
          <span className={valueClass}>{RAGDOLL_SOURCE_LABEL[ragdollSource]}</span>
        </Field>
        {ragdollRigId && <Button variant='subtle' size='sm' className='w-full mb-2' onClick={() => enterRigEditor(ragdollRigId)}>Edit ragdoll in rig</Button>}
        { ragdollSource === 'generic' ? <>
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
        </> : <>
          <Field label='Mass Scale' labelClassName={LABEL}>
            <NumberInput step={0.05} min={0.1} value={ragdoll.massScale ?? 1} onChange={(v) => setRagdoll({ ...ragdoll, massScale: Math.max(0.1, v) })} />
          </Field>
          <Field label='Push (m/s)' labelClassName={LABEL}>
            <AxisInput step={0.1} value={[ragdoll.impulse?.[0] ?? 0, ragdoll.impulse?.[1] ?? 0, ragdoll.impulse?.[2] ?? 0]} onChange={(v) => setRagdoll({ ...ragdoll, impulse: [v[0], v[1], v[2]] })} />
          </Field>
        </> }
      </div>
    </Collapsable>
    }
  </DocScope>)
}
