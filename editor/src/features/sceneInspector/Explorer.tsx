import { useEffect, useState } from 'react'
import Tabs, { Tab } from '../../components/Tabs'
import SceneInspector from './SceneInspector'
import UIInspector from '../uiInspector/UIInspector'
import { useCleoEngine } from '../EngineContext'

export default function Explorer() {
  const { eventEmitter: eventEmitter } = useCleoEngine()
  const [selectedTab, setSelectedTab] = useState<'Scene' | 'UI'>('Scene')

  useEffect(() => {
    // Let the UI overlay know which tab is active (it only shows on the UI tab in edit mode).
    eventEmitter.emit('EXPLORER_TAB', selectedTab)
    if (selectedTab === 'Scene')
      eventEmitter.emit('SCENE_CHANGED')
    if (selectedTab === 'UI')
      eventEmitter.emit('UI_CHANGED')
  }, [selectedTab])
  return (
    <>
      <Tabs>
        <Tab title='Scene' onClick={()=>{setSelectedTab('Scene')}} selected={selectedTab === 'Scene'}/>
        <Tab title='UI' onClick={()=>{setSelectedTab('UI')}} selected={selectedTab === 'UI'}/>
      </Tabs>
      <div className='flex flex-col text-white bg-[#202020] w-full h-full overflow-y-auto'>
        {selectedTab === 'Scene' && <SceneInspector />}
        {selectedTab === 'UI' && <UIInspector />}
      </div>
    </>
  )
}
