import { useEffect, useState } from 'react'
import Editor from './features/Editor'
import { EngineProvider } from './features/EngineContext'
import { VfsProvider } from './features/assets/VfsContext'
import { ScriptWorkspaceProvider } from './features/scriptWorkspace/ScriptWorkspaceContext'
import LoadingScreen from './components/LoadingScreen'
import ProjectLauncher from './features/projects/ProjectLauncher'
import { ProjectRecord, initProjects } from './utils/projects'

type BootState =
  | { phase: 'loading' }
  | { phase: 'launcher'; projects: ProjectRecord[] }
  | { phase: 'ready' }
  | { phase: 'error'; message: string }

/**
 * Nothing that reads storage may mount until a project is open.
 *
 * Every storage key the editor uses is namespaced by the open project, and `scoped()` throws while there
 * isn't one — deliberately, so a stray early read fails loudly instead of writing to a shared `p::` bucket.
 * So `initProjects()` (which also performs the one-time migration of a pre-multi-project install) has to
 * finish before <EngineProvider>, <VfsProvider> or <Editor> exist: the library loaders, setupInitialScene,
 * the VFS index read and DockLayout's synchronous localStorage reads all live inside that subtree.
 *
 * This is also the only place that can surface openDB's `onblocked` ("close the editor in other tabs")
 * — every other caller wraps it in a try/catch and degrades to empty data, which reads as data loss.
 */
export default function App() {
  const [state, setState] = useState<BootState>({ phase: 'loading' })

  useEffect(() => {
    let cancelled = false
    void initProjects()
      .then(({ projects, activeId }) => {
        if (cancelled) return
        setState(activeId ? { phase: 'ready' } : { phase: 'launcher', projects })
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ phase: 'error', message: String((e as Error)?.message ?? e) })
      })
    return () => { cancelled = true }
  }, [])

  if (state.phase === 'error') {
    return (
      <div className='h-screen w-screen flex items-center justify-center bg-bg text-fg p-8 text-center'>
        <div className='max-w-[520px] flex flex-col gap-3'>
          <h1 className='text-lg font-semibold text-danger'>Cleo could not open your projects</h1>
          <p className='text-sm text-slate-300'>{state.message}</p>
          <p className='text-xs text-dim'>
            If the editor is open in another tab or window, close it and reload — a storage upgrade cannot run
            while another tab holds the database.
          </p>
        </div>
      </div>
    )
  }

  if (state.phase === 'launcher') return <ProjectLauncher projects={state.projects} />

  if (state.phase === 'loading') {
    // LoadingScreen is `absolute inset-0`, so it needs a positioned host of its own out here.
    return (
      <div className='relative h-screen w-screen overflow-hidden'>
        <LoadingScreen progress={{ loaded: 0, total: 1, label: 'Opening project…' }} />
      </div>
    )
  }

  return (
    <div className="h-screen w-screen overflow-hidden">
        <EngineProvider>
            {/* The asset explorer's folder index sits above <Editor> so it keeps indexing new assets even
                while the Assets tab is hidden (renderer mode collapses the whole bottom bar). */}
            <VfsProvider>
                {/* Mirrors the script library to a folder on disk for editing in an external IDE. Inside
                    VfsProvider because it syncs the VFS layout as well as the sources. */}
                <ScriptWorkspaceProvider>
                    <Editor />
                </ScriptWorkspaceProvider>
            </VfsProvider>
        </EngineProvider>
    </div>
  )
}
