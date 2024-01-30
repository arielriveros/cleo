import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { ModelNode, Node } from 'cleo'
import Collapsable from '../../components/Collapsable'
import Sidebar from '../../components/Sidebar'
import TransformEditor from './TransformEditor'
import AddNew from './AddNew'
import './NodeInspector.css'
import MaterialEditor from './MaterialEditor'

export default function NodeInspector() {
  const { instance, selectedNode } = useCleoEngine()
  const [node, setNode] = useState<Node | null>(null)

  useEffect(() => {
    if (instance?.scene && selectedNode) {
      const node = instance.scene.getNodeById(selectedNode)
      if (node) setNode(node)
    }

  }, [selectedNode])

  return (
    <Sidebar width='30vw'> {
      node && 
        <div className='nodeInspector'>
            <Collapsable title='Node Information'>
              Name: {node.name}
              <br />
              Id: {node.id}
              <br />
              Type: { node.nodeType.charAt(0).toUpperCase() + node.nodeType.slice(1) }
              <br />
              Children: {node.children.length}
            </Collapsable>

            <TransformEditor node={node} />
            <AddNew node={node} />

            {
              node.nodeType === 'model' &&
                <MaterialEditor node={node as ModelNode} />
            }
            
        </div>
    } </Sidebar>
  )
}
