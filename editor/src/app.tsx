import Editor from './features/Editor'
import { EngineProvider } from './features/EngineContext'

export default function App() {
  return (
    <div>
        <EngineProvider>
            <Editor />
        </EngineProvider>
    </div>
    
  )
}
