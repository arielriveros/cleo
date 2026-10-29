import { useEffect, useState } from 'react'
import Editor from './features/Editor'
import { EngineProvider } from './features/EngineContext'
import { VfsProvider } from './features/assets/VfsContext'
import { AssetGraphProvider } from './features/assets/AssetGraphContext'
import { ScriptWorkspaceProvider } from './features/scriptWorkspace/ScriptWorkspaceContext'
import LoadingScreen from './components/LoadingScreen'
import { BOOT_TITLE, beginBootLoad } from './features/loading/bootLoad'
import { currentLoad } from '@cleo/app-kit/feedback/loadingStore'
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
 * Every storage key is namespaced by the open project and `scoped()` throws while there isn't one, so
 * `initProjects()` must finish before <EngineProvider>, <VfsProvider> or <Editor> exist. This is also
 * the only place that surfaces openDB's `onblocked` ("close the editor in other tabs").
 */
export default function App() {
  const [state, setState] = useState<BootState>({ phase: 'loading' })

  useEffect(() => {
    let cancelled = false
    // The startup load: begun here, before any project is open, and carried on by EngineContext. A
    // reload that ends another flow (installing an example, switching project) hands its title and
    // finished steps over, and they show first.
    const load = beginBootLoad()
    const step = load.step('project').start()
    void initProjects()
      .then(({ projects, activeId }) => {
        if (cancelled) return
        const active = projects.find(p => p.id === activeId)
        step.done(active?.name)
        // Named after the project — unless a hand-off already titled it ("Installing Hollow Keep").
        if (active && currentLoad()?.title === BOOT_TITLE) load.setTitle(`Opening ${active.name}`)
        // No project to open: the launcher takes over, and there is nothing left to load.
        if (!activeId) load.finish()
        setState(activeId ? { phase: 'ready' } : { phase: 'launcher', projects })
      })
      .catch((e: unknown) => {
        step.fail(String((e as Error)?.message ?? e))
        load.finish()
        if (!cancelled) setState({ phase: 'error', message: String((e as Error)?.message ?? e) })
      })
    return () => { cancelled = true }
  }, [])

  if (state.phase === 'error') {
    return (
      <div className='h-screen w-screen flex items-center justify-center bg-bg text-fg p-8 text-center'>
        <div className='max-w-[520px] flex flex-col gap-3'>
          <h1 className='text-lg font-semibold text-danger'>Cleo could not open your projects</h1>
          <p className='text-ui-lg text-fg'>{state.message}</p>
          <p className='text-ui text-dim'>
            If the editor is open in another tab or window, close it and reload — a storage upgrade cannot run
            while another tab holds the database.
          </p>
        </div>
      </div>
    )
  }

  // The full-window loading screen is mounted once, out here, so every flow can show it: the startup,
  // and an example install or project switch started from the launcher as much as from the editor.
  if (state.phase === 'launcher') return <><ProjectLauncher projects={state.projects} /><LoadingScreen /></>

  if (state.phase === 'loading') return <div className='h-screen w-screen bg-bg'><LoadingScreen /></div>

  return (
    <div className="h-screen w-screen overflow-hidden">
        <LoadingScreen />
        <EngineProvider>
            {/* The cross-asset reference graph. Above <Editor> and above the VFS: it is fed by the asset
                LIBRARIES, not by the folder index, and every open tab asks it whether its dependencies
                moved. */}
            <AssetGraphProvider>
            {/* The asset explorer's folder index sits above <Editor> so it keeps indexing new assets even
                while the Assets tab is hidden (options mode collapses the whole bottom bar). */}
            <VfsProvider>
                {/* Mirrors the script library to a folder on disk for editing in an external IDE. Inside
                    VfsProvider because it syncs the VFS layout as well as the sources. */}
                <ScriptWorkspaceProvider>
                    <Editor />
                </ScriptWorkspaceProvider>
            </VfsProvider>
            </AssetGraphProvider>
        </EngineProvider>
    </div>
  )
}
