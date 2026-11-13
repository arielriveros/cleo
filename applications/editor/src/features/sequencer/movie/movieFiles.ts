// Where a movie goes: one file the encoder streams into, or a folder of numbered frames.
//
// In the browser through the File System Access API (a save or folder picker, then writes at byte offsets
// straight to disk); on desktop through the shell's movie channel (app-kit/desktop/movieFiles.js), whose
// dialogs hand out the only paths it will write. Either way the bytes go to disk as they are made: a long
// 4K movie never sits in memory.

/** What the encoder writes: Mediabunny's StreamTarget chunks, which FileSystemWritableFileStream also takes. */
export type MovieChunk = { type: 'write'; data: Uint8Array; position: number }

export interface MovieFile {
  /** The file's name, for the progress line and the toast. */
  name: string
  writable: WritableStream<MovieChunk>
  /** Close the file and remove it (a cancelled or failed render that should leave nothing behind). */
  discard(): Promise<void>
}

export interface MovieFolder {
  name: string
  writeFile(name: string, data: Uint8Array): Promise<void>
  /** A streamed file inside the folder (the frames' sound). */
  openFile(name: string): Promise<MovieFile>
}

interface DesktopMovieBridge {
  pickFile(suggestedName: string, extension: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; name?: string }>
  pickFolder(): Promise<{ ok: boolean; canceled?: boolean; path?: string; name?: string }>
  open(target: string, name?: string): Promise<{ ok: boolean; handle?: number; error?: string }>
  write(handle: number, position: number, data: Uint8Array): Promise<{ ok: boolean; error?: string }>
  close(handle: number, abort?: boolean): Promise<{ ok: boolean; error?: string }>
  writeFile(dir: string, name: string, data: Uint8Array): Promise<{ ok: boolean; error?: string }>
  setBackgroundThrottling(allowed: boolean): Promise<{ ok: boolean }>
}

/** The desktop shell's movie channel, when this is a shell new enough to have one. */
function desktopMovie(): DesktopMovieBridge | null {
  const bridge = (typeof window !== 'undefined' ? (window as any).cleoDesktop?.movie : undefined) as DesktopMovieBridge | undefined
  return bridge && typeof bridge.pickFile === 'function' && typeof bridge.write === 'function' ? bridge : null
}

/** True when a movie can be written here at all. */
export function canWriteMovies(): boolean {
  return !!desktopMovie() || (typeof window !== 'undefined' && typeof (window as any).showSaveFilePicker === 'function')
}

/** Keep the window rendering at full speed in the background (desktop only; a browser tab cannot ask). */
export async function setBackgroundThrottling(allowed: boolean): Promise<void> {
  await desktopMovie()?.setBackgroundThrottling(allowed).catch(() => undefined)
}

function check(result: { ok: boolean; error?: string }, what: string): void {
  if (!result.ok) throw new Error(`${what}: ${result.error ?? 'failed'}`)
}

/** A desktop file handle as a stream of positioned writes. */
async function desktopFile(bridge: DesktopMovieBridge, target: string, name: string, inFolder?: string): Promise<MovieFile> {
  const opened = inFolder !== undefined ? await bridge.open(inFolder, name) : await bridge.open(target)
  check(opened, `Could not open ${name}`)
  const handle = opened.handle!
  let closed = false
  const writable = new WritableStream<MovieChunk>({
    async write(chunk) { check(await bridge.write(handle, chunk.position, chunk.data), `Could not write ${name}`) },
    async close() { closed = true; check(await bridge.close(handle), `Could not finish ${name}`) },
    async abort() { closed = true; await bridge.close(handle, true) },
  })
  return { name, writable, discard: async () => { if (!closed) { closed = true; await bridge.close(handle, true) } } }
}

/** A File System Access handle as a stream of positioned writes. */
async function browserFile(handle: any): Promise<MovieFile> {
  const stream = await handle.createWritable()
  let done = false
  const writable = new WritableStream<MovieChunk>({
    async write(chunk) { await stream.write({ type: 'write', position: chunk.position, data: chunk.data }) },
    async close() { done = true; await stream.close() },
    async abort(reason) { done = true; await stream.abort(reason) },
  })
  return { name: handle.name, writable, discard: async () => { if (!done) { done = true; await stream.abort().catch(() => undefined) } } }
}

/** Ask where to save the movie. Null when the user cancels. */
export async function pickMovieFile(suggestedName: string, extension: string): Promise<MovieFile | null> {
  const bridge = desktopMovie()
  if (bridge) {
    const picked = await bridge.pickFile(suggestedName, extension)
    if (!picked.ok || !picked.path) return null
    return desktopFile(bridge, picked.path, picked.name ?? suggestedName)
  }
  const picker = (window as any).showSaveFilePicker
  if (typeof picker !== 'function') throw new Error('This browser cannot save a file to disk (no File System Access). Use Chrome or Edge, or the desktop editor.')
  try {
    const handle = await picker({
      suggestedName,
      types: [{ description: extension.toUpperCase(), accept: { [extension === 'wav' ? 'audio/wav' : 'video/mp4']: [`.${extension}`] } }],
    })
    return browserFile(handle)
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return null
    throw e
  }
}

/** Ask for a folder to write the frames into. Null when the user cancels. */
export async function pickMovieFolder(): Promise<MovieFolder | null> {
  const bridge = desktopMovie()
  if (bridge) {
    const picked = await bridge.pickFolder()
    if (!picked.ok || !picked.path) return null
    const dir = picked.path
    return {
      name: picked.name ?? dir,
      writeFile: async (name, data) => check(await bridge.writeFile(dir, name, data), `Could not write ${name}`),
      openFile: name => desktopFile(bridge, dir, name, dir),
    }
  }
  const picker = (window as any).showDirectoryPicker
  if (typeof picker !== 'function') throw new Error('This browser cannot write a folder (no File System Access). Use Chrome or Edge, or the desktop editor.')
  let dir: any
  try {
    dir = await picker({ mode: 'readwrite' })
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return null
    throw e
  }
  return {
    name: dir.name,
    writeFile: async (name, data) => {
      const handle = await dir.getFileHandle(name, { create: true })
      const stream = await handle.createWritable()
      await stream.write(data)
      await stream.close()
    },
    openFile: async name => browserFile(await dir.getFileHandle(name, { create: true })),
  }
}
