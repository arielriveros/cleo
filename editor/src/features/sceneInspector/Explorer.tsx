import { useEffect, useState } from 'react'
import Tabs, { Tab } from '../../components/Tabs'
import SceneInspector from './SceneInspector'
import { useCleoEngine } from '../EngineContext'

export default function Explorer() {
  const { eventEmitter: eventEmitter } = useCleoEngine()
  const [selectedTab, setSelectedTab] = useState<'Scene'>('Scene')

  useEffect(() => {
    if (selectedTab === 'Scene') 
      eventEmitter.emit('SCENE_CHANGED')
  }, [selectedTab])
  return (
    <>
      <Tabs>
        <Tab title='Scene' onClick={()=>{setSelectedTab('Scene')}} selected={selectedTab === 'Scene'}/>
      </Tabs>
      <div className='flex flex-col text-white bg-[#202020] w-full h-full overflow-y-auto'>
        {selectedTab === 'Scene' && <SceneInspector />}
      </div>
    </>
  )
}
