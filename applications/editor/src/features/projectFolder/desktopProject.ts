// The typed face of the desktop shell's project-folder bridge (`window.cleoDesktop.project`, preload.js ->
// projectFolder.js). Absent in the web build, where projects stay in IndexedDB.

/** One file as the main process last saw it. `sha` is the sha256 of its bytes. */
export interface FileStat { rel: string; size: number; mtimeMs: number; sha: string }

/** A folder as the main process lists it: files outside Blobs/, folders under the data dirs, blob digests. */
export interface FolderListing { files: FileStat[]; dirs: string[]; blobs: string[] }

/** What changed on disk since the last report, outside the editor. */
export interface FolderChange {
  files?: { added: FileStat[]; changed: FileStat[]; removed: string[] }
  dirs?: { added: string[]; removed: string[] }
  blobs?: { added: string[]; removed: string[] }
  rootMissing?: true
  rootRestored?: true
}

/**
 * One batch of writes. `expect` is the sha the editor last agreed is on disk (null: "must not exist");
 * the main process refuses an overwrite or delete whose file no longer matches, and reports it.
 */
export interface FolderBatch {
  blobs?: { hash: string; data: Uint8Array }[]
  deletes?: { rel: string; expect?: string | null }[]
  dirRenames?: { from: string; to: string }[]
  renames?: { from: string; to: string; expect?: string | null }[]
  mkdirs?: string[]
  writes?: { rel: string; data: string | Uint8Array; expect?: string | null }[]
  rmdirs?: string[]
  /** False to delete asset files outright instead of moving them to the OS trash. */
  trash?: boolean
}

export interface FolderApplyResult {
  ok: boolean
  error?: string
  /** rel -> its stat after the batch, null when it was deleted or moved away. */
  stats: Record<string, Omit<FileStat, 'rel'> | null>
  conflicts: { rel: string; op: 'write' | 'delete' | 'rename'; actual: string | null }[]
  errors: { rel: string; op: string; error: string }[]
}

export interface RegistryEntry { root: string; lastOpened: number; name?: string; missing: boolean; project: string | null }

export interface LaunchRequest { root: string; play: boolean; debug: boolean }

type Ok<T = {}> = Promise<({ ok: true } & T) | { ok: false; error?: string; canceled?: boolean; [k: string]: unknown }>

export interface ProjectBridge {
  registry(): Ok<{ projects: RegistryEntry[] }>
  forget(root: string): Ok
  remember(root: string, name?: string): Ok
  defaultParent(): Ok<{ path: string }>
  hasCommand(command: 'git' | 'npm'): Ok<{ present: boolean }>
  pickLocation(options: { title?: string; name: string; parent?: string }): Ok<{ parent: string; root: string }>
  pickProject(options?: { title?: string; parent?: string }): Ok<{ root: string; project: string }>
  inspect(root: string): Ok<{ exists: boolean; isDirectory?: boolean; empty: boolean; isProject: boolean; project?: string | null; entries?: number }>
  prepareNew(root: string): Ok<{ root: string }>
  open(root: string, options?: { force?: boolean; allowNew?: boolean; name?: string }): Ok<{ root: string } & FolderListing>
  close(root: string): Ok
  relist(root: string): Ok<FolderListing>
  read(root: string, rels: string[]): Ok<{ files: { rel: string; data: Uint8Array | null; error?: string }[] }>
  readBlobs(root: string, hashes: string[]): Ok<{ blobs: { hash: string; data: Uint8Array | null; error?: string }[] }>
  apply(root: string, batch: FolderBatch): Promise<FolderApplyResult>
  gc(root: string, hashes: string[]): Ok<{ removed: number }>
  writeScaffold(root: string, files: { rel: string; content: string | Uint8Array; keep?: boolean }[]): Ok<{ written: number }>
  reveal(root: string, rel?: string): Ok
  launch(root: string, rel?: string, command?: string, line?: number): Ok<{ via: string }>
  gitInit(root: string): Ok
  npmInstall(root: string): Ok
  trashFolder(root: string): Ok
  takeLaunchRequest(): Promise<LaunchRequest | null>
  /** Write the project's `cleo` package (.cleo/sdk/cleo) and link node_modules/cleo to it. */
  installSdk(root: string, typesHash?: string): Ok<{ installed: boolean; runtime: boolean; needTypes: boolean }>
  onChange(cb: (payload: { root: string; change: FolderChange }) => void): () => void
  onLaunchRequest(cb: (request: LaunchRequest) => void): () => void
  onNpmOutput(cb: (payload: { root: string; text: string }) => void): () => void
}

export function getProjectBridge(): ProjectBridge | undefined {
  return (globalThis as any).cleoDesktop?.project as ProjectBridge | undefined
}

/** True in the desktop app, where every project is a folder. */
export function hasProjectFolders(): boolean {
  return !!getProjectBridge()
}

/** The bridge, or a clear error where there is none (a folder code path reached in the web build). */
export function requireProjectBridge(): ProjectBridge {
  const bridge = getProjectBridge()
  if (!bridge) throw new Error('Project folders need the Cleo desktop app')
  return bridge
}

/** The largest batch one IPC call carries (projectFolder.js MAX_BATCH_BYTES); bigger ones are split. */
export const MAX_BATCH_BYTES = 64 * 1024 * 1024

/** A command from the project's `cleo` CLI, relayed by the desktop shell (controlPipe.js). */
export interface ControlCommand { id: number; cmd: 'ping' | 'play' | 'open'; root?: string; debug?: boolean }

export interface ControlBridge {
  ready(): Promise<unknown>
  reply(id: number, result: Record<string, unknown>): Promise<unknown>
  onCommand(cb: (command: ControlCommand) => void): () => void
}

export function getControlBridge(): ControlBridge | undefined {
  return (globalThis as any).cleoDesktop?.control as ControlBridge | undefined
}
