import { useEffect, useState } from 'react';
import { Geometry, Material, Model, ModelNode, Node, Vec } from 'cleo'
import { BodyDescription, ShapeDescription, useCleoEngine } from '../../EngineContext';
import Collapsable from '../../../components/Collapsable'
import ShapeEditor from './ShapeEditor';
import './Styles.css'

export default function PhysicsEditor(props: {node: Node}) {
  const { bodies, triggers, eventEmmiter } = useCleoEngine();
  const [bodyProperties, setBodyProperties] = useState<BodyDescription | null>(null)
  const [triggerProperties, setTriggerProperties] = useState<{shapes: ShapeDescription[]} | null>(null);
  const [sceneChanged, setSceneChanged] = useState(false);

  useEffect(() => {
    const handleSceneChanged = () => { setSceneChanged(true); };
    eventEmmiter.on('sceneChanged', handleSceneChanged);
    return () => { eventEmmiter.off('sceneChanged', handleSceneChanged) };
  }, [eventEmmiter]);

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
    <div className='body-editor'>
        { !bodyProperties ? 
        <> {
          props.node.name === 'root' ?
            <p> Root node cannot have a rigid body. </p> :
            /* TODO: Temporary solution, in the future inner nodes should be able to have bodies */
            props.node.parent?.name !== 'root' ? <p> Can only add rigid bodies to nodes at root level. </p> :
          <>
            <p>Node does not have a rigid body.</p> 
            <button onClick={() => setBodyProperties({
              mass: 0,
              linearDamping: 0,
              angularDamping: 0,
              linearConstraints: [1, 1, 1],
              angularConstraints: [1, 1, 1],
              shapes: [] })}> Add Rigid Body </button>
          </>
        } </>
        : <>
            <div className='body-editor-row'>
              <label>Mass</label>
              <div>
                <input type='number' value={bodyProperties.mass} onChange={(e) => setBodyProperties({...bodyProperties, mass: parseFloat(e.target.value)})} />
                {bodyProperties.mass === 0 && <p>Mass of 0 will make the object static</p> }
              </div>
            </div>
            <div className='body-editor-row'>
              <label>Damping</label>
              <div>
                <input type='range' value={bodyProperties.linearDamping} step={0.01} min={0} max={1} onChange={(e) => setBodyProperties({...bodyProperties, linearDamping: parseFloat(e.target.value)})} />
                { bodyProperties.linearDamping }
              </div>
            </div>
            <div className='body-editor-row'>
              <label>Angular Damping</label>
              <div>
                <input type='range' value={bodyProperties.angularDamping} step={0.01} min={0} max={1} onChange={(e) => setBodyProperties({...bodyProperties, angularDamping: parseFloat(e.target.value)})} />
                { bodyProperties.angularDamping }
              </div>
            </div>
            <div className='body-editor-row'>
              <label>Linear Constraints</label>
              <div>
                <label>X</label>
                <input type='checkbox' checked={bodyProperties.linearConstraints[0] === 1} onChange={(e) => setBodyProperties({...bodyProperties, linearConstraints: [e.target.checked ? 1 : 0, bodyProperties.linearConstraints[1], bodyProperties.linearConstraints[2]]})} />
                <label>Y</label>
                <input type='checkbox' checked={bodyProperties.linearConstraints[1] === 1} onChange={(e) => setBodyProperties({...bodyProperties, linearConstraints: [bodyProperties.linearConstraints[0], e.target.checked ? 1 : 0, bodyProperties.linearConstraints[2]]})} />
                <label>Z</label>
                <input type='checkbox' checked={bodyProperties.linearConstraints[2] === 1} onChange={(e) => setBodyProperties({...bodyProperties, linearConstraints: [bodyProperties.linearConstraints[0], bodyProperties.linearConstraints[1], e.target.checked ? 1 : 0]})} />
              </div>
            </div>
            <div className='body-editor-row'>
              <label>Angular Constraints</label>
              <div>
                <label>X</label>
                <input type='checkbox' checked={bodyProperties.angularConstraints[0] === 1} onChange={(e) => setBodyProperties({...bodyProperties, angularConstraints: [e.target.checked ? 1 : 0, bodyProperties.angularConstraints[1], bodyProperties.angularConstraints[2]]})} />
                <label>Y</label>
                <input type='checkbox' checked={bodyProperties.angularConstraints[1] === 1} onChange={(e) => setBodyProperties({...bodyProperties, angularConstraints: [bodyProperties.angularConstraints[0], e.target.checked ? 1 : 0, bodyProperties.angularConstraints[2]]})} />
                <label>Z</label>
                <input type='checkbox' checked={bodyProperties.angularConstraints[2] === 1} onChange={(e) => setBodyProperties({...bodyProperties, angularConstraints: [bodyProperties.angularConstraints[0], bodyProperties.angularConstraints[1], e.target.checked ? 1 : 0]})} />
              </div>
            </div>
            <button onClick={() => removeBody()}>Remove Rigid Body</button>
        </>
        }
      </div>
    { bodyProperties &&
      <div className='body-editor'>
        <p>Shapes</p>
        <div className='body-editor-row'>
          Add Shape:
          <button onClick={() => addShape('box', 'body')}>Box</button>
          <button onClick={() => addShape('sphere', 'body')}>Sphere</button>
          <button onClick={() => addShape('cylinder', 'body')}>Cylinder</button>
          <button onClick={() => addShape('plane', 'body')}>Plane</button>
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
      <div className='body-editor'>
        {
          !triggerProperties ? 
          <>
            <p>Node does not have a trigger.</p>
            <button onClick={() => setTriggerProperties({ shapes: [] })}> Add Trigger </button>
          </>
          :
          <>
          <button onClick={() => removeTrigger()}>Remove Trigger</button>
          { triggerProperties &&
            <div className='body-editor'>
              <p>Shapes</p>
              <div className='body-editor-row'>
                Add Shape:
                <button onClick={() => addShape('box', 'trigger')}>Box</button>
                <button onClick={() => addShape('sphere', 'trigger')}>Sphere</button>
                <button onClick={() => addShape('cylinder', 'trigger')}>Cylinder</button>
                <button onClick={() => addShape('plane', 'trigger')}>Plane</button>
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
  </>)
}
