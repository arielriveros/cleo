import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import Editor from './features/Editor'
import { EngineProvider } from './features/EngineContext'
import { VfsProvider } from './features/assets/VfsContext'
import { AssetGraphProvider } from './features/assets/AssetGraphContext'
import { ScriptWorkspaceProvider } from './features/scriptWorkspace/ScriptWorkspaceContext'
import LoadingScreen from './components/LoadingScreen'
import { BOOT_TITLE, beginBootLoad } from './features/loading/bootLoad'
import { continueLoad, currentLoad } from '@cleo/app-kit/feedback/loadingStore'
import ProjectLauncher from './features/projects/ProjectLauncher'
import { ProjectRecord, initProjects, loadProjects } from './utils/projects'
import { registerProjectHost } from './features/projects/projectSwitch'
import { reloadDiscarding } from './features/unloadGuard'
import { Button } from '@cleo/app-kit/ui'

type BootState =
  | { phase: 'loading' }
  | { phase: 'launcher'; projects: ProjectRecord[] }
  /** A project is open. `epoch` counts the projects opened in this window: a new one mounts everything afresh. */
  | { phase: 'ready'; epoch: number }
  /** Between two projects (features/projects/projectSwitch.ts): only the loading screen is up. */
  | { phase: 'switching' }
  | { phase: 'switchFailed'; message: string }
  | { phase: 'error'; message: string }

/**
 * Nothing that reads storage may mount until a project is open.
 *
 * Every storage key is namespaced by the open project and `scoped()` throws while there isn't one, so
 * `initProjects()` must finish before <EngineProvider>, <VfsProvider> or <Editor> exist. This is also
 * the only place that surfaces openDB's `onblocked` ("close the editor in other tabs").
 *
 * Opening another project does not reload the page: projectSwitch takes the providers out (the `switching`
 * phase), and puts them back with a new `epoch` once the next project is the open one.
 */
export default function App() {
  const [state, setState] = useState<BootState>({ phase: 'loading' })
  const epochRef = useRef(0)
  /** Resolves the unmount a switch is waiting on, once the `switching` phase has committed. */
  const unmountedRef = useRef<(() => void) | null>(null)

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
        setState(activeId ? { phase: 'ready', epoch: ++epochRef.current } : { phase: 'launcher', projects })
      })
      .catch((e: unknown) => {
        step.fail(String((e as Error)?.message ?? e))
        load.finish()
        if (!cancelled) setState({ phase: 'error', message: String((e as Error)?.message ?? e) })
      })
    return () => { cancelled = true }
  }, [])

  // What a project switch asks of the page.
  useEffect(() => registerProjectHost({
    unmount: () => new Promise<void>(resolve => {
      unmountedRef.current = resolve
      setState(s => (s.phase === 'switching' ? s : { phase: 'switching' }))
    }),
    mount: () => setState({ phase: 'ready', epoch: ++epochRef.current }),
    showLauncher: async () => {
      const projects = await loadProjects()
      continueLoad()?.finish()
      setState({ phase: 'launcher', projects })
    },
    showFailure: message => setState({ phase: 'switchFailed', message }),
  }), [])

  // The unmount has committed: every provider's cleanup ran with it (React runs a removed tree's effect
  // cleanups before the new commit's effects), so the switch can go on.
  useEffect(() => {
    if (state.phase !== 'switching' && state.phase !== 'launcher' && state.phase !== 'switchFailed') return
    const resolve = unmountedRef.current
    unmountedRef.current = null
    resolve?.()
  }, [state])

  if (state.phase === 'error' || state.phase === 'switchFailed') {
    const failed = state.phase === 'switchFailed'
    return (
      <div className='h-screen w-screen flex items-center justify-center bg-bg text-fg p-8 text-center'>
        <LoadingScreen />
        <div className='max-w-[520px] flex flex-col gap-3'>
          <h1 className='text-lg font-semibold text-danger'>{failed ? 'Cleo could not open the project' : 'Cleo could not open your projects'}</h1>
          <p className='text-ui-lg text-fg'>{state.message}</p>
          {failed ? (
            <div className='flex gap-2 justify-center'>
              <Button onClick={() => { void loadProjects().then(projects => setState({ phase: 'launcher', projects })) }}>
                Open another project
              </Button>
              <Button onClick={() => reloadDiscarding()}>Reload editor</Button>
            </div>
          ) : (
            <p className='text-ui text-dim'>
              If the editor is open in another tab or window, close it and reload — a storage upgrade cannot run
              while another tab holds the database.
            </p>
          )}
        </div>
      </div>
    )
  }

  // The full-window loading screen is mounted once, out here, so every flow can show it: the startup,
  // and an example install or project switch started from the launcher as much as from the editor.
  if (state.phase === 'launcher') return <><ProjectLauncher projects={state.projects} /><LoadingScreen /></>

  if (state.phase === 'loading' || state.phase === 'switching') return <div className='h-screen w-screen bg-bg'><LoadingScreen /></div>

  return (
    <div className="h-screen w-screen overflow-hidden">
        <LoadingScreen />
        <ProjectBoundary key={state.epoch} onError={message => setState({ phase: 'switchFailed', message })}>
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
        </ProjectBoundary>
    </div>
  )
}

/**
 * One open project's providers. Keyed by the project epoch, so another project mounts them afresh; a throw
 * while rendering them is the switch's failure screen, not a white page.
 */
class ProjectBoundary extends Component<{ children: ReactNode; onError: (message: string) => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(error: unknown): void {
    this.props.onError(String((error as Error)?.message ?? error))
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
