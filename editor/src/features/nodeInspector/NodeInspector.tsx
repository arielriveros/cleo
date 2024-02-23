import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { Node } from 'cleo'
import Tabs, { Tab } from "../../components/Tabs";
import PropertyEditor from './propertyEditors/PropertyEditor';
import ScriptSelector from './scriptEditor/ScriptSelector';
import ScriptEditor from './scriptEditor/ScriptEditor';
import PhysicsEditor from './physicsEditors/PhysicsEditor';
import './NodeInspector.css'

export default function NodeInspector() {
  const { editorScene, selectedNode, selectedScript } = useCleoEngine()
  const [node, setNode] = useState<Node | null>(null)
  const [selectedTab, setSelectedTab] = useState<'Properties' | 'Scripts' | 'Physics'>('Properties')

  useEffect(() => {
    if (editorScene && selectedNode) {
      const node = editorScene.getNodeById(selectedNode)
      if (node) setNode(node)
    }

  }, [selectedNode])

  return (
    <>
      <Tabs>
        <Tab title='Properties' onClick={()=>{setSelectedTab('Properties')}} selected={selectedTab === 'Properties'}/>
        <Tab title='Scripts' onClick={()=>{setSelectedTab('Scripts')}} selected={selectedTab === 'Scripts'}/>
        <Tab title='Physics' onClick={()=>{setSelectedTab('Physics')}} selected={selectedTab === 'Physics'}/>
      </Tabs>
      <div className='nodeInspector'>
        {selectedTab === 'Properties' && node && <PropertyEditor node={node}/>}
        {selectedTab === 'Scripts' && <>
          <ScriptSelector />
          { selectedScript && <ScriptEditor /> }
        </>}
        {selectedTab === 'Physics' && node && <PhysicsEditor node={node} />}
      </div>
    </>
  )
}
