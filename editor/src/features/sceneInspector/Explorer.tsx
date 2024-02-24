import { useEffect, useState } from 'react'
import Tabs, { Tab } from '../../components/Tabs'
import SceneInspector from './SceneInspector'
import TextureExplorer from './TextureExplorer'
import { useCleoEngine } from '../EngineContext'

export default function Explorer() {
  const { eventEmmiter } = useCleoEngine()
  const [selectedTab, setSelectedTab] = useState<'Scene' | 'Assets'>('Scene')

  useEffect(() => {
    if (selectedTab === 'Scene') 
      eventEmmiter.emit('sceneChanged')

    if (selectedTab === 'Assets')
      eventEmmiter.emit('texturesChanged')
  }, [selectedTab])
  return (
    <>
      <Tabs>
        <Tab title='Scene' onClick={()=>{setSelectedTab('Scene')}} selected={selectedTab === 'Scene'}/>
        <Tab title='Assets' onClick={()=>{setSelectedTab('Assets')}} selected={selectedTab === 'Assets'}/>
      </Tabs>
      <div className='explorer'>
        {selectedTab === 'Scene' && <SceneInspector />}
        {selectedTab === 'Assets' && <div>
          <TextureExplorer />
        </div>}
      </div>
    </>
  )
}
