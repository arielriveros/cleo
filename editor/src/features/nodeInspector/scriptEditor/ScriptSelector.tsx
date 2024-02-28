import { useEffect } from 'react';
import Tabs, { Tab } from '../../../components/Tabs';
import { useCleoEngine } from '../../EngineContext'

export default function ScriptSelector() {
  const { selectedScript, eventEmmiter } = useCleoEngine();

  useEffect(() => {
    return () => { eventEmmiter.emit('SELECT_SCRIPT', null) }
  }, [eventEmmiter])

  return (
    <Tabs>
      <Tab title='OnSpawn' onClick={() => eventEmmiter.emit('SELECT_SCRIPT', 'OnSpawn')} selected={selectedScript === 'OnSpawn'}/>
      <Tab title='OnStart' onClick={() => eventEmmiter.emit('SELECT_SCRIPT', 'OnStart')} selected={selectedScript === 'OnStart'}/>
      <Tab title='OnUpdate' onClick={() => eventEmmiter.emit('SELECT_SCRIPT', 'OnUpdate')} selected={selectedScript === 'OnUpdate'}/>
      <Tab title='OnCollision' onClick={() => eventEmmiter.emit('SELECT_SCRIPT', 'OnCollision')} selected={selectedScript === 'OnCollision'}/>
      <Tab title='OnTrigger' onClick={() => eventEmmiter.emit('SELECT_SCRIPT', 'OnTrigger')} selected={selectedScript === 'OnTrigger'}/>
    </Tabs>
  )
}
