import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { Node, ModelNode } from 'cleo'
import Tabs, { Tab } from "../../components/Tabs";
import PropertyEditor from './propertyEditors/PropertyEditor';
import MaterialEditor from './propertyEditors/MaterialEditor';
import ScriptEditor from './scriptEditor/ScriptEditor';
import PhysicsEditor from './physicsEditors/PhysicsEditor';
import StateMachineEditor from '../animation/StateMachineEditor';
import TerrainMaterialInspector from '../terrainMaterials/TerrainMaterialInspector';
import { isWithinTemplateInstance } from '../../utils/templates';

export default function NodeInspector() {
  const { editorScene, selectedNode, editorMode, eventEmitter, editingMaterialName, setActiveMaterialName, editingTerrainMaterialNode } = useCleoEngine()
  const [node, setNode] = useState<Node | null>(null)
  const [selectedTab, setSelectedTab] = useState<'Properties' | 'Script' | 'Physics'>('Properties')

  useEffect(() => {
    if (editorScene && selectedNode) {
      const node = editorScene.getNodeById(selectedNode)
      if (node) setNode(node)
    }

  }, [selectedNode])

  // Animation editor mode: the right sidebar becomes the animation state machine / events authoring.
  if (editorMode === 'animation') {
    return <StateMachineEditor />
  }

  // Terrain-material editor mode: surface (MaterialEditor) + terrain blend + foliage authoring. Edits the
  // dedicated (unrendered) edit node — the visible preview node carries the composite terrain material.
  if (editorMode === 'terrainMaterial') {
    return <TerrainMaterialInspector node={editingTerrainMaterialNode} />
  }

  // Material editor mode: the inspector focuses on the preview sphere's material only (name + controls).
  if (editorMode === 'material') {
    return (
      <div className='flex flex-col text-white bg-[#202020] w-full h-full overflow-y-auto'>
        <div className='p-2 border-b border-[#2d2d77]'>
          <label className='text-xs text-slate-300 block mb-1'>Material name</label>
          <input
            className='bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1 w-full text-sm'
            value={editingMaterialName ?? ''}
            onChange={(e) => setActiveMaterialName(e.target.value)} />
        </div>
        {/* Any edit inside the material controls marks the tab dirty (drives the unsaved dot / close guard). */}
        {node && node.nodeType === 'model' &&
          <div onChange={() => eventEmitter.emit('SCENE_CHANGED')}>
            <MaterialEditor node={node as ModelNode} />
          </div>}
      </div>
    )
  }

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
      </Tabs>
      {readOnly && <div className='text-[11px] text-[#ffd27a] bg-[#3a2f12] px-2 py-1'>Template instance — edit the template to change its content (Transform is per-instance).</div>}
      <div className='flex flex-col text-white bg-[#202020] w-full h-full overflow-y-auto'>
        {selectedTab === 'Properties' && node && <PropertyEditor node={node} readOnly={readOnly}/>}
        {selectedTab === 'Script'  && <ScriptEditor readOnly={readOnly} /> }
        {selectedTab === 'Physics' && node && <fieldset disabled={readOnly} className={gate}><PhysicsEditor node={node} /></fieldset>}
      </div>
    </>
  )
}
