import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { ModelNode, Node, SkyboxNode } from 'cleo'
import Collapsable from '../../components/Collapsable'
import Sidebar from '../../components/Sidebar'
import TransformEditor from './TransformEditor'
import MaterialEditor from './MaterialEditor'
import SkyboxEditor from './SkyboxEditor'
import './NodeInspector.css'

export default function NodeInspector() {
  const { scene, selectedNode } = useCleoEngine()
  const [node, setNode] = useState<Node | null>(null)

  useEffect(() => {
    if (scene && selectedNode) {
      const node = scene.getNodeById(selectedNode)
      if (node) setNode(node)
    }

  }, [selectedNode])

  return (
    <Sidebar width='30vw'> 
      <div className='nodeInspector'>
      { node && 
        <>
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

          { node.nodeType === 'model' && <MaterialEditor node={node as ModelNode} /> }
          { node.nodeType === 'skybox' && <SkyboxEditor node={node as SkyboxNode} /> }
        </>
      } </div>
    </Sidebar>
  )
}
