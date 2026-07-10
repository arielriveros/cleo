import { useEffect, useState } from 'react';
import { ModelNode, AnimatedModel, Node, RAGDOLL_DEFAULTS } from 'cleo'
import type { RagdollOptions } from 'cleo'
import { BodyDescription, ShapeDescription, useCleoEngine } from '../../EngineContext';
import Collapsable from '../../../components/Collapsable'
import AxisInput from '../../../components/AxisInput'
import ShapeEditor from './ShapeEditor';

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

  const section = 'w-full p-2';
  const row = 'flex items-center gap-2 my-1';
  const label = 'w-[160px]';
  const number = 'bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1 w-[120px]';

  const addBtn = 'ml-2 px-2 py-1 bg-[#3b3b3b] border border-[#2d2d77] rounded hover:bg-[#3f3fb4]';

  const addShape = (type: string, target: 'body' | 'trigger') => {
    switch (type) {
      case 'box':
        if (target === 'body')
          setBodyProperties({...bodyProperties!, shapes: [...bodyProperties!.shapes, { type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }]});
        else
          setTriggerProperties({...triggerProperties!, shapes: [...triggerProperties!.shapes, { type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }]});
        break;
      case 'sphere':
        if (target === 'body')
          setBodyProperties({...bodyProperties!, shapes: [...bodyProperties!.shapes, { type: 'sphere', radius: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }]});
        else
          setTriggerProperties({...triggerProperties!, shapes: [...triggerProperties!.shapes, { type: 'sphere', radius: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }]});
        break;
      case 'cylinder':
        if (target === 'body')
          setBodyProperties({...bodyProperties!, shapes: [...bodyProperties!.shapes, { type: 'cylinder', radius: 1, height: 1, numSegments: 16, offset: [0, 0, 0], rotation: [0, 0, 0] }]});
        else
          setTriggerProperties({...triggerProperties, shapes: [...triggerProperties!.shapes, { type: 'cylinder', radius: 1, height: 1, numSegments: 16, offset: [0, 0, 0], rotation: [0, 0, 0] }]});
        break;
      case 'plane':
        if (target === 'body')
          setBodyProperties({...bodyProperties!, shapes: [...bodyProperties!.shapes, { type: 'plane', offset: [0, 0, 0], rotation: [0, 0, 0] }]});
        else
          setTriggerProperties({...triggerProperties, shapes: [...triggerProperties!.shapes, { type: 'plane', offset: [0, 0, 0], rotation: [0, 0, 0] }]});
        break;
    }
  }

  // Shape/body/trigger removal just updates the data; the reconciler rebuilds or removes the debug
  // wireframes (setBodyProperties/setTriggerProperties re-run the persist effects above, which emit
  // PHYSICS_CHANGED; the explicit emits below cover the null case where those effects short-circuit).
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

  const removeBody = () => {
    bodies.delete(props.node.id);
    setBodyProperties(null);
    eventEmitter.emit('PHYSICS_CHANGED');
  }

  const removeTrigger = () => {
    triggers.delete(props.node.id);
    setTriggerProperties(null);
    eventEmitter.emit('PHYSICS_CHANGED');
  }

  return ( <>
    <Collapsable title='Rigid Body'>
    <div className={section}>
        { !bodyProperties ? 
        <> {
          props.node.name === 'root' ?
            <p> Root node cannot have a rigid body. </p> :
            /* TODO: Temporary solution, in the future inner nodes should be able to have bodies */
            props.node.parent?.name !== 'root' ? <p> Can only add rigid bodies to nodes at root level. </p> :
          <>
            <p>Node does not have a rigid body.</p> 
            <button className={addBtn} onClick={() => setBodyProperties({
              mass: 0,
              linearDamping: 0,
              angularDamping: 0,
              linearConstraints: [1, 1, 1],
              angularConstraints: [1, 1, 1],
              shapes: [] })}> Add Rigid Body </button>
          </>
        } </>
        : <>
            <div className={row}>
              <label className={label}>Mass</label>
              <div>
                <input className={number} type='number' value={bodyProperties.mass} onChange={(e) => setBodyProperties({...bodyProperties, mass: parseFloat(e.target.value)})} />
                {bodyProperties.mass === 0 && <p className='text-xs text-gray-300'>Mass of 0 will make the object static</p> }
              </div>
            </div>
            <div className={row}>
              <label className={label}>Damping</label>
              <div>
                <input className='w-[200px]' type='range' value={bodyProperties.linearDamping} step={0.01} min={0} max={1} onChange={(e) => setBodyProperties({...bodyProperties, linearDamping: parseFloat(e.target.value)})} />
                { bodyProperties.linearDamping }
              </div>
            </div>
            <div className={row}>
              <label className={label}>Angular Damping</label>
              <div>
                <input className='w-[200px]' type='range' value={bodyProperties.angularDamping} step={0.01} min={0} max={1} onChange={(e) => setBodyProperties({...bodyProperties, angularDamping: parseFloat(e.target.value)})} />
                { bodyProperties.angularDamping }
              </div>
            </div>
            <div className={row}>
              <label className={label}>Linear Constraints</label>
              <div className='flex items-center gap-2'>
                <label>X</label>
                <input type='checkbox' checked={bodyProperties.linearConstraints[0] === 1} onChange={(e) => setBodyProperties({...bodyProperties, linearConstraints: [e.target.checked ? 1 : 0, bodyProperties.linearConstraints[1], bodyProperties.linearConstraints[2]]})} />
                <label>Y</label>
                <input type='checkbox' checked={bodyProperties.linearConstraints[1] === 1} onChange={(e) => setBodyProperties({...bodyProperties, linearConstraints: [bodyProperties.linearConstraints[0], e.target.checked ? 1 : 0, bodyProperties.linearConstraints[2]]})} />
                <label>Z</label>
                <input type='checkbox' checked={bodyProperties.linearConstraints[2] === 1} onChange={(e) => setBodyProperties({...bodyProperties, linearConstraints: [bodyProperties.linearConstraints[0], bodyProperties.linearConstraints[1], e.target.checked ? 1 : 0]})} />
              </div>
            </div>
            <div className={row}>
              <label className={label}>Angular Constraints</label>
              <div className='flex items-center gap-2'>
                <label>X</label>
                <input type='checkbox' checked={bodyProperties.angularConstraints[0] === 1} onChange={(e) => setBodyProperties({...bodyProperties, angularConstraints: [e.target.checked ? 1 : 0, bodyProperties.angularConstraints[1], bodyProperties.angularConstraints[2]]})} />
                <label>Y</label>
                <input type='checkbox' checked={bodyProperties.angularConstraints[1] === 1} onChange={(e) => setBodyProperties({...bodyProperties, angularConstraints: [bodyProperties.angularConstraints[0], e.target.checked ? 1 : 0, bodyProperties.angularConstraints[2]]})} />
                <label>Z</label>
                <input type='checkbox' checked={bodyProperties.angularConstraints[2] === 1} onChange={(e) => setBodyProperties({...bodyProperties, angularConstraints: [bodyProperties.angularConstraints[0], bodyProperties.angularConstraints[1], e.target.checked ? 1 : 0]})} />
              </div>
            </div>
            <button className={addBtn} onClick={() => removeBody()}>Remove Rigid Body</button>
        </>
        }
      </div>
    { bodyProperties &&
      <div className={section}>
        <p>Shapes</p>
        <div className={row}>
          Add Shape:
          <button className={addBtn} onClick={() => addShape('box', 'body')}>Box</button>
          <button className={addBtn} onClick={() => addShape('sphere', 'body')}>Sphere</button>
          <button className={addBtn} onClick={() => addShape('cylinder', 'body')}>Cylinder</button>
          <button className={addBtn} onClick={() => addShape('plane', 'body')}>Plane</button>
        </div>
        { bodyProperties.shapes.map((shape, i) => 
          <ShapeEditor key={i} shape={shape} setShape={(newShape: any) => {
            const newShapes = [...bodyProperties.shapes];
            newShapes[i] = newShape;
            setBodyProperties({...bodyProperties, shapes: newShapes})
            }}
            removeShape={() => {
              removeShape(i, 'body');
            }}
          />
        )}
      </div>}
    </Collapsable>
    <Collapsable title='Trigger'>
      <div className={section}>
        {
          !triggerProperties ? 
          <>
            <p>Node does not have a trigger.</p>
            <button className={addBtn} onClick={() => setTriggerProperties({ shapes: [] })}> Add Trigger </button>
          </>
          :
          <>
          <button className={addBtn} onClick={() => removeTrigger()}>Remove Trigger</button>
          { triggerProperties &&
            <div className={section}>
              <p>Shapes</p>
              <div className={row}>
                Add Shape:
                <button className={addBtn} onClick={() => addShape('box', 'trigger')}>Box</button>
                <button className={addBtn} onClick={() => addShape('sphere', 'trigger')}>Sphere</button>
                <button className={addBtn} onClick={() => addShape('cylinder', 'trigger')}>Cylinder</button>
                <button className={addBtn} onClick={() => addShape('plane', 'trigger')}>Plane</button>
              </div>
              { triggerProperties.shapes.map((shape, i) => 
                <ShapeEditor key={i} shape={shape} setShape={(newShape: any) => {
                  const newShapes = [...triggerProperties.shapes];
                  newShapes[i] = newShape;
                  setTriggerProperties({...triggerProperties, shapes: newShapes})
                  }}
                  removeShape={() => {
                    removeShape(i, 'trigger');
                  }}
                />
              )}
            </div>}
          </>
        }
      </div>
    </Collapsable>
    { isSkinned && ragdoll &&
    <Collapsable title='Ragdoll'>
      <div className={section}>
        <p className='text-xs text-gray-300 mb-2'>How this skinned mesh simulates when turned into a ragdoll.</p>
        <div className={row}>
          <label className={label}>Joint Type</label>
          <select className={number} value={ragdoll.jointType}
            onChange={(e) => setRagdoll({ ...ragdoll, jointType: e.target.value as 'ball' | 'coneTwist' })}>
            <option value='ball'>Ball (free, stable)</option>
            <option value='coneTwist'>Cone-Twist (limited)</option>
          </select>
        </div>
        { ragdoll.jointType === 'coneTwist' && <>
          <div className={row}>
            <label className={label}>Cone Angle</label>
            <div>
              <input className='w-[200px]' type='range' min={0} max={180} step={1} value={ragdoll.coneAngle}
                onChange={(e) => setRagdoll({ ...ragdoll, coneAngle: parseFloat(e.target.value) })} />
              {' '}{ragdoll.coneAngle}°
            </div>
          </div>
          <div className={row}>
            <label className={label}>Twist Angle</label>
            <div>
              <input className='w-[200px]' type='range' min={0} max={180} step={1} value={ragdoll.twistAngle}
                onChange={(e) => setRagdoll({ ...ragdoll, twistAngle: parseFloat(e.target.value) })} />
              {' '}{ragdoll.twistAngle}°
            </div>
          </div>
          <div className={row}>
            <label className={label}>Stiffness</label>
            <input className={number} type='number' value={ragdoll.stiffness}
              onChange={(e) => setRagdoll({ ...ragdoll, stiffness: parseFloat(e.target.value) })} />
          </div>
        </> }
        <div className={row}>
          <label className={label}>Angular Damping</label>
          <div>
            <input className='w-[200px]' type='range' min={0} max={1} step={0.01} value={ragdoll.angularDamping}
              onChange={(e) => setRagdoll({ ...ragdoll, angularDamping: parseFloat(e.target.value) })} />
            {' '}{ragdoll.angularDamping}
          </div>
        </div>
        <div className={row}>
          <label className={label}>Linear Damping</label>
          <div>
            <input className='w-[200px]' type='range' min={0} max={1} step={0.01} value={ragdoll.linearDamping}
              onChange={(e) => setRagdoll({ ...ragdoll, linearDamping: parseFloat(e.target.value) })} />
            {' '}{ragdoll.linearDamping}
          </div>
        </div>
        <div className={row}>
          <label className={label}>Bone Mass</label>
          <input className={number} type='number' step={0.1} value={ragdoll.boneMass}
            onChange={(e) => setRagdoll({ ...ragdoll, boneMass: parseFloat(e.target.value) })} />
        </div>
        <div className={row}>
          <label className={label}>Radius Scale</label>
          <input className={number} type='number' step={0.05} value={ragdoll.radiusScale}
            onChange={(e) => setRagdoll({ ...ragdoll, radiusScale: parseFloat(e.target.value) })} />
        </div>
        <div className={row}>
          <label className={label}>Self Collision</label>
          <input type='checkbox' checked={!!ragdoll.selfCollision}
            onChange={(e) => setRagdoll({ ...ragdoll, selfCollision: e.target.checked })} />
        </div>
        <div className={row}>
          <label className={label}>Knockback Impulse</label>
          <div className='w-[200px]'>
            <AxisInput step={0.1}
              value={[ragdoll.impulse?.[0] ?? 0, ragdoll.impulse?.[1] ?? 0, ragdoll.impulse?.[2] ?? 0]}
              onChange={(v) => setRagdoll({ ...ragdoll, impulse: [v[0], v[1], v[2]] })} />
          </div>
        </div>
      </div>
    </Collapsable>
    }
  </>)
}
