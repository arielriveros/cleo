import type { ExternalChange } from '../../utils/scriptMirror'

// Typed view of the script-workspace half of `window.cleoDesktop` (desktop/preload.js). Mirrors the
// shape publishClient.ts uses for the publish half: the bridge only exists inside the Electron shell, so
// every caller goes through `hasScriptWorkspace()` and the web build simply has the feature disabled.

export type ScriptBatch = {
  deletes?: string[]
  renames?: { from: string; to: string }[]
  writes?: { rel: string; source: string }[]
  manifest?: unknown
}

export type OpenResult = {
  ok: boolean
  error?: string
  files: { rel: string; source: string }[]
  manifest: unknown
}

export type ScriptsBridge = {
  pickFolder(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  open(root: string): Promise<OpenResult>
  close(root: string): Promise<{ ok: boolean }>
  apply(root: string, batch: ScriptBatch): Promise<{ ok: boolean; error?: string }>
  writeScaffold(root: string, files: { rel: string; content: string }[]): Promise<{ ok: boolean; error?: string }>
  launch(root: string, rel?: string, command?: string): Promise<{ ok: boolean; via?: string; error?: string }>
  exists(root: string): Promise<{ ok: boolean; exists?: boolean }>
  onChange(cb: (payload: { root: string; change: ExternalChange }) => void): () => void
}

export function getScriptsBridge(): ScriptsBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as any).cleoDesktop?.scripts as ScriptsBridge | undefined
}

/** True only inside the desktop shell. The workspace needs a filesystem and a watcher; a browser has neither. */
export function hasScriptWorkspace(): boolean {
  return !!getScriptsBridge()
}

export const NOT_DESKTOP_REASON =
  'Editing scripts in VSCode needs filesystem access, which is only available in the desktop app.'
