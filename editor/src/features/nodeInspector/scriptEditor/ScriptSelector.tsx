import { useEffect } from 'react';
import Tabs, { Tab } from '../../../components/Tabs';
import { useCleoEngine } from '../../EngineContext'

export default function ScriptSelector() {
  const { selectedScript, eventEmmiter } = useCleoEngine();

  useEffect(() => {
    return () => { eventEmmiter.emit('selectScript', null) }
  }, [eventEmmiter])

  return (
    <Tabs>
      <Tab title='OnSpawn' onClick={() => eventEmmiter.emit('selectScript', 'OnSpawn')} selected={selectedScript === 'OnSpawn'}/>
      <Tab title='OnStart' onClick={() => eventEmmiter.emit('selectScript', 'OnStart')} selected={selectedScript === 'OnStart'}/>
      <Tab title='OnUpdate' onClick={() => eventEmmiter.emit('selectScript', 'OnUpdate')} selected={selectedScript === 'OnUpdate'}/>
      <Tab title='OnCollision' onClick={() => eventEmmiter.emit('selectScript', 'OnCollision')} selected={selectedScript === 'OnCollision'}/>
    </Tabs>
  )
}
