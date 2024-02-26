import { Geometry, Material, Model, ModelNode, Node, Vec } from 'cleo'
import { useEffect, useState } from 'react';
import { ShapeDescription, useCleoEngine } from '../../EngineContext';
import Collapsable from '../../../components/Collapsable'
import ShapeEditor from './ShapeEditor';
import './Styles.css'

export default function PhysicsEditor(props: {node: Node}) {
    const { bodies, eventEmmiter } = useCleoEngine();
    const [properties, setProperties] = useState<{mass: number; linearDamping: number; angularDamping: number; shapes: ShapeDescription[] } | null>(null)
    const [sceneChanged, setSceneChanged] = useState(false);

    useEffect(() => {
      const handleSceneChanged = () => { setSceneChanged(true); };
      eventEmmiter.on('sceneChanged', handleSceneChanged);
      return () => { eventEmmiter.off('sceneChanged', handleSceneChanged) };
    }, [eventEmmiter]);

    useEffect(() => {
      if (sceneChanged) {
        setSceneChanged(false);
        // re-render the component without changing the state
        // Add logic to handle scene changes here
      }
    }, [sceneChanged]);


    useEffect(() => {
      const body = bodies.get(props.node.id);
      if (body)
        setProperties({
          mass: body.mass,
          linearDamping: body.linearDamping,
          angularDamping: body.angularDamping,
          shapes: body.shapes
        })

      else setProperties(null)

    }, [props.node, bodies])

    useEffect(() => {
      if (properties) {
        bodies.set(props.node.id, { mass: properties.mass, linearDamping: properties.linearDamping, angularDamping: properties.angularDamping, shapes: properties.shapes}) 
        const node = new Node(`__debug__body_${props.node.id}`)
        node.onUpdate = () => {
          node.setPosition(props.node.position);
          node.setRotation(props.node.rotation);
        }
        props.node.scene?.addNode(node);
      }
      else {
        bodies.delete(props.node.id)
        const nodeToDelete = props.node.scene?.getNodesByName(`__debug__body_${props.node.id}`)[0]
        if (nodeToDelete) props.node.scene?.removeNode(nodeToDelete)
      }
    }, [properties])

    const addShape = (type: string) => {
      if (!properties) return;
      let model: Model | null;
      switch (type) {
        case 'box':
          setProperties({...properties, shapes: [...properties.shapes, { type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }]});
          model = new Model(Geometry.Cube(1.01, 1.01, 1.01, true), Material.Basic({color: [1, 0, 0]}, {wireframe: true}));
          break;
        case 'sphere':
          setProperties({...properties, shapes: [...properties.shapes, { type: 'sphere', radius: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }]});
          model = new Model(Geometry.Sphere(8, 1.01), Material.Basic({color: [1, 0, 0]}, {wireframe: true}));
          break;
        case 'plane':
          setProperties({...properties, shapes: [...properties.shapes, { type: 'plane', offset: [0, 0, 0], rotation: [0, 0, 0] }]});
          model = null;
          break;
        default:
          model = null;
      }
      if (model) {
        const node = new ModelNode(`__debug__shape_${type}`, model)
        props.node.scene?.getNodesByName(`__debug__body_${props.node.id}`)[0]?.addChild(node);
      }
    }

  return (
    <>
    <Collapsable title='Rigid Body'>
    <div className='body-editor'>
        { !properties ? 
        <> {
          props.node.name === 'root' ?
            <p> Root node cannot have a rigid body. </p> :
            /* TODO: Temporary solution, in the future inner nodes should be able to have bodies */
            props.node.parent?.name !== 'root' ? <p> Can only add rigid bodies to nodes at root level. </p> :
          <>
            <p>Node does not have a rigid body</p> 
            <button onClick={() => setProperties({ mass: 0, linearDamping: 0, angularDamping: 0, shapes: [] })}>Add Rigid Body</button>
          </>
        } </>
        : <>
            <div className='body-editor-row'>
              <label>Mass</label>
              <div>
                <input type='number' value={properties.mass} onChange={(e) => setProperties({...properties, mass: parseFloat(e.target.value)})} />
                {properties.mass === 0 && <p>Mass of 0 will make the object static</p> }
              </div>
            </div>
            <div className='body-editor-row'>
              <label>Damping</label>
              <div>
                <input type='range' value={properties.linearDamping} step={0.01} min={0} max={1} onChange={(e) => setProperties({...properties, linearDamping: parseFloat(e.target.value)})} />
                { properties.linearDamping }
              </div>
            </div>
            <div className='body-editor-row'>
              <label>Angular Damping</label>
              <div>
                <input type='range' value={properties.angularDamping} step={0.01} min={0} max={1} onChange={(e) => setProperties({...properties, angularDamping: parseFloat(e.target.value)})} />
                { properties.angularDamping }
              </div>
            </div>
            <button onClick={() => setProperties(null)}>Remove Rigid Body</button>
        </>
        }
      </div>
    </Collapsable>
    { properties &&
      <Collapsable title='Collision Shapes'>
        <button onClick={() => addShape('box')}>Add Box</button>
        <button onClick={() => addShape('sphere')}>Add Sphere</button>
        <button onClick={() => addShape('plane')}>Add Plane</button>
        { properties.shapes.map((shape, i) => 
          <ShapeEditor key={i} shape={shape} setShape={(newShape: any) => {
            const newShapes = [...properties.shapes];
            newShapes[i] = newShape;
            setProperties({...properties, shapes: newShapes})
            }}
            removeShape={() => {
              const newShapes = [...properties.shapes];
              newShapes.splice(i, 1);
              setProperties({...properties, shapes: newShapes})
            }}
          />
        )}
      </Collapsable>}
    </>)
}
