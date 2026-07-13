import Editor from './features/Editor'
import { EngineProvider } from './features/EngineContext'
import { VfsProvider } from './features/assets/VfsContext'

export default function App() {
  return (
    <div className="h-screen w-screen overflow-hidden">
        <EngineProvider>
            {/* The asset explorer's folder index sits above <Editor> so it keeps indexing new assets even
                while the Assets tab is hidden (renderer mode collapses the whole bottom bar). */}
            <VfsProvider>
                <Editor />
            </VfsProvider>
        </EngineProvider>
    </div>

  )
}
