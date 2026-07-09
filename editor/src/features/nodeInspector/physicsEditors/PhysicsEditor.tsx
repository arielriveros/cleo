import { useEffect, useState } from 'react';
import { Geometry, Material, Model, ModelNode, AnimatedModel, Node, Vec, RAGDOLL_DEFAULTS } from 'cleo'
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

  useEffect(() => {
    if (bodyProperties ) {
      bodies.set(props.node.id, {
        mass: bodyProperties.mass,
        linearDamping: bodyProperties.linearDamping,
        angularDamping: bodyProperties.angularDamping,
        linearConstraints: bodyProperties.linearConstraints,
        angularConstraints: bodyProperties.angularConstraints,
        shapes: bodyProperties.shapes
      });
      // Check if scene contains a debug node for this body, if not, create one
      if (!props.node.scene?.getNodesByName(`__debug__body_${props.node.id}`)[0]) {
        const node = new Node(`__debug__body_${props.node.id}`)
        node.onUpdate = () => {
          node.setPosition(props.node.position);
          node.setRotation(props.node.rotation);
        }
        props.node.scene?.addNode(node);
      }
    }
  }, [bodyProperties])

  useEffect(() => {
    if (!bodyProperties) return;
    const node = props.node.scene?.getNodesByName(`__debug__body_${props.node.id}`)[0];
    // Setup debug shapes for each shape in the body
    bodyProperties.shapes.forEach((shape, i) => {
      // First check if the debug node contains a model for this shape, if not, create one
      if (!node?.getChildByName(`__debug__shape_${i}`)[0]) {
        let model: Model | null;
        switch (shape.type) {
          case 'box':
            model = new Model(Geometry.Cube(shape.width, shape.height, shape.depth, true), Material.Basic({color: [1, 0, 0]}, {wireframe: true}));
            break;
          case 'sphere':
            model = new Model(Geometry.Sphere(8, shape.radius), Material.Basic({color: [1, 0, 0]}, {wireframe: true}));
            break;
          case 'cylinder':
            model = new Model(Geometry.Cylinder(12, shape.radius, shape.height), Material.Basic({color: [1, 0, 0]}, {wireframe: true}));
            break;
          case 'plane':
            model = null;
            break;
          default:
            model = null;
        }
        if (model) {
          const modelNode = new ModelNode(`__debug__shape_${i}`, model)
          node?.addChild(modelNode);
        }
      }
      // Update position and rotation of the model
      const modelNode = node?.getChildByName(`__debug__shape_${i}`)[0];
      if (modelNode) {
        modelNode.setPosition(Vec.vec3.fromValues(shape.offset[0], shape.offset[1], shape.offset[2]))
                  .setRotation(Vec.vec3.fromValues(shape.rotation[0], shape.rotation[1], shape.rotation[2]));
      }
      
      // Update shape properties
      if (modelNode && shape.type === 'box') {
        modelNode.setScale(Vec.vec3.fromValues(shape.width, shape.height, shape.depth));
      }
      if (modelNode && shape.type === 'sphere') {
        modelNode.setUniformScale(shape.radius);
      }
      if (modelNode && shape.type === 'cylinder') {
        modelNode.setScale(Vec.vec3.fromValues(shape.radius, shape.height, shape.radius));
      }
    })
  }, [bodyProperties?.shapes] )

  useEffect(() => {
    const trigger = triggers.get(props.node.id);
    if (trigger)
      setTriggerProperties({shapes: trigger.shapes})
    else setTriggerProperties(null)
  }, [props.node, triggers])

  useEffect(() => {
    if (triggerProperties ) {
      triggers.set(props.node.id, { shapes: triggerProperties.shapes });
      // Check if scene contains a debug node for this body, if not, create one
      if (!props.node.scene?.getNodesByName(`__debug__trigger_${props.node.id}`)[0]) {
        const node = new Node(`__debug__trigger_${props.node.id}`)
        node.onUpdate = () => {
          node.setPosition(props.node.worldPosition);
          node.setQuaternion(props.node.worldQuaternion);
        }
        props.node.scene?.addNode(node);
      }
    }
  }, [triggerProperties])

  useEffect(() => {
    if (!triggerProperties) return;
    const node = props.node.scene?.getNodesByName(`__debug__trigger_${props.node.id}`)[0];
    // Setup debug shapes for each shape in the trigger
    triggerProperties.shapes.forEach((shape, i) => {
      // First check if the debug node contains a model for this shape, if not, create one
      if (!node?.getChildByName(`__debug__shape_${i}`)[0]) {
        let model: Model | null;
        switch (shape.type) {
          case 'box':
            model = new Model(Geometry.Cube(shape.width, shape.height, shape.depth, true), Material.Basic({color: [0, 1, 0]}, {wireframe: true}));
            break;
          case 'sphere':
            model = new Model(Geometry.Sphere(8, shape.radius), Material.Basic({color: [0, 1, 0]}, {wireframe: true}));
            break;
          case 'cylinder':
            model = new Model(Geometry.Cylinder(12, shape.radius, shape.height), Material.Basic({color: [0, 1, 0]}, {wireframe: true}));
            break;
          case 'plane':
            model = null;
            break;
          default:
            model = null;
        }
        if (model) {
          const modelNode = new ModelNode(`__debug__shape_${i}`, model)
          node?.addChild(modelNode);
        }
      }
      // Update position and rotation of the model
      const modelNode = node?.getChildByName(`__debug__shape_${i}`)[0];
      if (modelNode) {
        modelNode.setPosition(Vec.vec3.fromValues(shape.offset[0], shape.offset[1], shape.offset[2]))
                  .setRotation(Vec.vec3.fromValues(shape.rotation[0], shape.rotation[1], shape.rotation[2]));
      }
      
      // Update shape properties
      if (modelNode && shape.type === 'box') {
        modelNode.setScale(Vec.vec3.fromValues(shape.width, shape.height, shape.depth));
      }
      if (modelNode && shape.type === 'sphere') {
        modelNode.setUniformScale(shape.radius);
      }
      if (modelNode && shape.type === 'cylinder') {
        modelNode.setScale(Vec.vec3.fromValues(shape.radius, shape.height, shape.radius));
      }
    })
  }, [triggerProperties?.shapes] )

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

  const removeShape = (shapeIndex: number, target: 'body' | 'trigger') => {
    if (target === 'body' && bodyProperties) {
      const newShapes = [...bodyProperties.shapes];
      newShapes.splice(shapeIndex, 1);
      setBodyProperties({...bodyProperties, shapes: newShapes})
      // Remove debug model
      const node = props.node.scene?.getNodesByName(`__debug__body_${props.node.id}`)[0];
      const modelNode = node?.getChildByName(`__debug__shape_${shapeIndex}`)[0];
      if (modelNode) node?.removeChild(modelNode);
      // Update the names of the models
      node?.children.forEach((child, i) => {
        child.name = `__debug__shape_${i}`;
      })
    }
    if (target === 'trigger' && triggerProperties) {
      const newShapes = [...triggerProperties.shapes];
      newShapes.splice(shapeIndex, 1);
      setTriggerProperties({...triggerProperties, shapes: newShapes})
      // Remove debug model
      const node = props.node.scene?.getNodesByName(`__debug__trigger_${props.node.id}`)[0];
      const modelNode = node?.getChildByName(`__debug__shape_${shapeIndex}`)[0];
      if (modelNode) node?.removeChild(modelNode);
      // Update the names of the models
      node?.children.forEach((child, i) => {
        child.name = `__debug__shape_${i}`;
      })
    }
  };

  const removeBody = () => {
    bodies.delete(props.node.id);
    const nodeToRemove = props.node.scene?.getNodesByName(`__debug__body_${props.node.id}`)[0];
    if (nodeToRemove) props.node.scene?.removeNode(nodeToRemove);
    setBodyProperties(null);
  }

  const removeTrigger = () => {
    triggers.delete(props.node.id);
    const nodeToRemove = props.node.scene?.getNodesByName(`__debug__trigger_${props.node.id}`)[0];
    if (nodeToRemove) props.node.scene?.removeNode(nodeToRemove);
    setTriggerProperties(null);
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
