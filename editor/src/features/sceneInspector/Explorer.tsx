import { useEffect, useState } from 'react'
import Tabs, { Tab } from '../../components/Tabs'
import SceneInspector from './SceneInspector'
import UIInspector from '../uiInspector/UIInspector'
import SkeletonTree from '../animation/SkeletonTree'
import { useCleoEngine } from '../EngineContext'

export default function Explorer() {
  const { eventEmitter: eventEmitter, editorMode } = useCleoEngine()
  const [selectedTab, setSelectedTab] = useState<'Scene' | 'UI'>('Scene')

  // The UI tab is irrelevant while authoring a template; fall back to Scene so we don't render
  // UIInspector on a now-hidden tab.
  useEffect(() => {
    if (editorMode === 'template' && selectedTab === 'UI') setSelectedTab('Scene')
  }, [editorMode, selectedTab])

  useEffect(() => {
    // Let the UI overlay know which tab is active (it only shows on the UI tab in edit mode).
    eventEmitter.emit('EXPLORER_TAB', selectedTab)
    if (selectedTab === 'Scene')
      eventEmitter.emit('SCENE_CHANGED')
    if (selectedTab === 'UI')
      eventEmitter.emit('UI_CHANGED')
  }, [selectedTab])

  // The Animation Editor replaces the scene tree with the skeleton tree.
  if (editorMode === 'animation') return <SkeletonTree />

  return (
    <>
      <Tabs>
        <Tab title='Scene' onClick={()=>{setSelectedTab('Scene')}} selected={selectedTab === 'Scene'}/>
        { editorMode !== 'template' &&
          <Tab title='UI' onClick={()=>{setSelectedTab('UI')}} selected={selectedTab === 'UI'}/> }
      </Tabs>
      <div className='flex flex-col text-white bg-surface-raised w-full h-full overflow-y-auto'>
        {selectedTab === 'Scene' && <SceneInspector />}
        {selectedTab === 'UI' && <UIInspector />}
      </div>
    </>
  )
}
