import { useEffect, useState } from 'react'
import { useCleoEngine } from '../../EngineContext'
import './Styles.css'

export default function ScriptDescription() {
  const [scriptDescription, setScriptDescription] = useState('')
  const {selectedScript} = useCleoEngine()

  useEffect(() => {
    switch (selectedScript) {
      case 'OnSpawn':
        setScriptDescription('This script will be executed when the node is spawned even before the scene starts.')
        break
      case 'OnStart':
        setScriptDescription('This script will be executed when the node is started, if the scene has already started this script will be executed immediately after the node is added to the scene.')
        break
      case 'OnUpdate':
        setScriptDescription('This script will be executed after rendering the frame.')
        break
      case 'OnCollision':
        setScriptDescription('This script will be executed when the node collides with another node.')
        break
      default:
        setScriptDescription('')
    }
  }, [selectedScript])

  return (
    <section className='description-container'>
      {scriptDescription}
    </section>
  )
}
