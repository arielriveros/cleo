import React, { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import { PROJECT_TYPES_REL, getProjectTypes, subscribeProjectTypes } from '@cleo/app-kit/code/projectTypes'
import { Logger } from 'cleo'
import { setExternalScriptOpener } from '../options/scriptOpener'
import { folderSession } from '../projectFolder/folderSession'
import { folderSink } from '../projectFolder/folderSink'
import { openProjectInCodeEditor } from '../projectFolder/folderActions'
import { getProjectBridge } from '../projectFolder/desktopProject'

// Scripts as files an external editor (VS Code) can open. A desktop project IS a folder (features/
// projectFolder), so its scripts are already files there: under Assets/, at the path the Assets panel shows,
// as `<name>.ts`. This context is what the rest of the editor asks about them — is there a folder, open a
// script in VS Code at a line — and it keeps the project's own type declarations (its animators' trigger
// names, projectTypes.ts) written for the IDE.
//
// It used to mirror the script library into a folder of its own (the "script workspace"); the project folder
// replaced that. The web build has no folder: everything here reports `off`.

export type WorkspaceStatus = 'off' | 'connecting' | 'live' | 'paused' | 'error'

/** An external edit that arrived while the same script had unsaved changes in the editor. */
export type ScriptConflict = { scriptId: string; name: string; external: string; mine: string }

type ScriptWorkspaceValue = {
  status: WorkspaceStatus
  /** The project folder, or null (the web build). */
  rootPath: string | null
  message: string | null
  conflicts: ScriptConflict[]
  /** Kept for callers from before project folders: there is nothing to set up, the folder is the project. */
  setup: () => Promise<boolean>
  disconnect: () => Promise<void>
  /** Open the project folder in the external editor, at one script's file and `line` (1-based) when given. */
  openInEditor: (scriptId?: string, line?: number) => Promise<boolean>
  /** Write whatever the editor holds that the folder does not have yet. */
  resync: () => Promise<void>
  applyPendingDeletions: () => Promise<void>
  resolveConflict: (scriptId: string, keep: 'external' | 'mine') => void
  available: boolean
}

const ScriptWorkspaceContext = createContext<ScriptWorkspaceValue | null>(null)

export function useScriptWorkspace(): ScriptWorkspaceValue {
  const ctx = useContext(ScriptWorkspaceContext)
  if (!ctx) throw new Error('useScriptWorkspace must be used within a ScriptWorkspaceProvider')
  return ctx
}

/** The file a script is in, from the folder session's state (its identity is the meta's, not the name). */
function relOfScript(scriptId: string): string | undefined {
  const s = folderSession()
  if (!s) return undefined
  for (const [rel, f] of s.state) if (f.kind === 'script' && f.guid === scriptId) return rel
  return undefined
}

export function ScriptWorkspaceProvider({ children }: { children: React.ReactNode }) {
  const session = folderSession()
  const root = session?.root ?? null

  const openInEditor = useCallback(async (scriptId?: string, line?: number): Promise<boolean> => {
    if (!folderSession()) return false
    // Pending writes first, so a script created a moment ago is a file by the time the IDE looks for it.
    await folderSink.flushNow()
    const rel = scriptId ? relOfScript(scriptId) : undefined
    return openProjectInCodeEditor(rel, rel ? line : undefined)
  }, [])

  // "Open scripts with VS Code" (Options ▸ Editor): the engine context's script opener routes through here.
  useEffect(() => {
    if (!root) { setExternalScriptOpener(null); return }
    setExternalScriptOpener((scriptId, line) => openInEditor(scriptId, line))
    return () => setExternalScriptOpener(null)
  }, [root, openInEditor])

  // The project's own declarations, so the IDE checks scripts as the in-editor editor does.
  const projectTypes = useSyncExternalStore(subscribeProjectTypes, getProjectTypes)
  useEffect(() => {
    const bridge = getProjectBridge()
    if (!root || !bridge) return
    void bridge.writeScaffold(root, [{ rel: PROJECT_TYPES_REL, content: projectTypes || 'export {}\n' }])
      .then(res => { if (!res.ok) Logger.warn(`Could not write the project's type declarations: ${res.error}`, 'Editor') })
  }, [root, projectTypes])

  const value = useMemo<ScriptWorkspaceValue>(() => ({
    status: root ? 'live' : 'off',
    rootPath: root,
    message: null,
    conflicts: [],
    setup: async () => !!root,
    disconnect: async () => {},
    openInEditor,
    resync: () => folderSink.flushNow(),
    applyPendingDeletions: async () => { folderSink.confirmDeletes() },
    resolveConflict: () => {},
    available: !!root,
  }), [root, openInEditor])

  return <ScriptWorkspaceContext.Provider value={value}>{children}</ScriptWorkspaceContext.Provider>
}
