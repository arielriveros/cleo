import Editor from './features/Editor'
import { EngineProvider } from './features/EngineContext'

export default function App() {
  return (
    <div className="h-screen w-screen overflow-hidden">
        <EngineProvider>
            <Editor />
        </EngineProvider>
    </div>

  )
}
