import { Node } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import { useState } from 'react';

export default function PhysicsEditor(props: {node: Node}) {

    const [properties, setProperties] = useState<{mass: number; damping: number; angularDamping: number; }>({ mass: 0, damping: 0, angularDamping: 0 })

    const addRigidBody = (node: Node) => {node.setBody( properties.mass, properties.damping, properties.angularDamping)};

  return (
    <Collapsable title='Rigid Body'>
        {props.node.body ? 'Rigid Body' : 'No Rigid Body'}
        <br />
        <input type='number' value={properties.mass} onChange={(e) => setProperties({...properties, mass: parseFloat(e.target.value)})} />
        <br />
        <input type='number' value={properties.damping} onChange={(e) => setProperties({...properties, damping: parseFloat(e.target.value)})} />
        <br />
        <input type='number' value={properties.angularDamping} onChange={(e) => setProperties({...properties, angularDamping: parseFloat(e.target.value)})} />
        <br />
        <button onClick={()=>{addRigidBody(props.node)}}>Add Rigid Body</button>
    </Collapsable> )
}
