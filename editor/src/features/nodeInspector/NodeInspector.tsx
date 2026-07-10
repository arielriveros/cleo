import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { Node } from 'cleo'
import Tabs, { Tab } from "../../components/Tabs";
import PropertyEditor from './propertyEditors/PropertyEditor';
import ScriptEditor from './scriptEditor/ScriptEditor';
import PhysicsEditor from './physicsEditors/PhysicsEditor';
import AnimationEditor from './animationEditor/AnimationEditor';
import { isWithinTemplateInstance } from '../../utils/templates';

export default function NodeInspector() {
  const { editorScene, selectedNode, editorMode } = useCleoEngine()
  const [node, setNode] = useState<Node | null>(null)
  const [selectedTab, setSelectedTab] = useState<'Properties' | 'Script' | 'Physics' | 'Animation'>('Properties')

  useEffect(() => {
    if (editorScene && selectedNode) {
      const node = editorScene.getNodeById(selectedNode)
      if (node) setNode(node)
    }

  }, [selectedNode])

  // A placed template instance (and its children) is read-only in Scene mode, except its Transform.
  // Template mode itself stays fully editable (that's where the template is authored).
  const readOnly = editorMode === 'scene' && !!node && isWithinTemplateInstance(node);
  const gate = `${readOnly ? 'opacity-60' : ''} border-0 m-0 p-0 min-w-0`;

  return (
    <>
      <Tabs>
        <Tab title='Properties' onClick={()=>{setSelectedTab('Properties')}} selected={selectedTab === 'Properties'}/>
        <Tab title='Scripts' onClick={()=>{setSelectedTab('Script')}} selected={selectedTab === 'Script'}/>
        <Tab title='Physics' onClick={()=>{setSelectedTab('Physics')}} selected={selectedTab === 'Physics'}/>
        <Tab title='Animation' onClick={()=>{setSelectedTab('Animation')}} selected={selectedTab === 'Animation'}/>
      </Tabs>
      {readOnly && <div className='text-[11px] text-[#ffd27a] bg-[#3a2f12] px-2 py-1'>Template instance — edit the template to change its content (Transform is per-instance).</div>}
      <div className='flex flex-col text-white bg-[#202020] w-full h-full overflow-y-auto'>
        {selectedTab === 'Properties' && node && <PropertyEditor node={node} readOnly={readOnly}/>}
        {selectedTab === 'Script'  && <ScriptEditor readOnly={readOnly} /> }
        {selectedTab === 'Physics' && node && <fieldset disabled={readOnly} className={gate}><PhysicsEditor node={node} /></fieldset>}
        {selectedTab === 'Animation' && node && <fieldset disabled={readOnly} className={gate}><AnimationEditor node={node} /></fieldset>}
      </div>
    </>
  )
}
