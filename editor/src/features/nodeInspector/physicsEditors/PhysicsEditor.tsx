import { Node } from 'cleo'
import { useEffect, useState } from 'react';
import { ShapeDescription, useCleoEngine } from '../../EngineContext';
import Collapsable from '../../../components/Collapsable'
import ShapeEditor from './ShapeEditor';
import './Styles.css'


export default function PhysicsEditor(props: {node: Node}) {
    const { bodies } = useCleoEngine();
    const [properties, setProperties] = useState<{mass: number; linearDamping: number; angularDamping: number; shapes: ShapeDescription[] } | null>(null)

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
      if (properties)
        bodies.set(props.node.id, { mass: properties.mass, linearDamping: properties.linearDamping, angularDamping: properties.angularDamping, shapes: properties.shapes}) 
      else 
        bodies.delete(props.node.id)
    }, [properties])

  return (
    <>
    <Collapsable title='Rigid Body'>
        { !properties ? 
        <>
          {
            props.node.name === 'root' ? <p>Root node cannot have a rigid body</p> :
            <>
              <p>Node does not have a rigid body</p> 
              <button onClick={() => setProperties({ mass: 0, linearDamping: 0, angularDamping: 0, shapes: [] })}>Add Rigid Body</button>
            </>
          }
        </>
        : <>
          <div className='body-editor'>
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
          </div>
        </>
        }
    </Collapsable>
    { properties &&
      <Collapsable title='Collision Shapes'>
        <button onClick={() => setProperties({...properties, shapes: [...properties.shapes, { type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }]})}>Add Box</button>
        <button onClick={() => setProperties({...properties, shapes: [...properties.shapes, { type: 'sphere', radius: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }]})}>Add Sphere</button>
        <button onClick={() => setProperties({...properties, shapes: [...properties.shapes, { type: 'plane', offset: [0, 0, 0], rotation: [0, 0, 0] }]})}>Add Plane</button>
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
