// Path helpers for an asset explorer's tree: every path is absolute and starts with '/', the root itself
// is '/'. Shared by the editor's asset index (utils/vfs.ts re-exports them) and the Creator's library
// explorer, and by the SVAR store sync (fileManagerSync.ts).

/** The parent folder of a path. '/a/b.mat' -> '/a'; '/a.mat' -> '/'. */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

/** The basename, extension included. '/a/Rock.mat' -> 'Rock.mat'. */
export function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The extension, dot included, taken after the LAST dot (as SVAR does). 'Rock.mat' -> '.mat'; 'Rock' -> ''. */
export function extOf(path: string): string {
  const base = baseOf(path)
  const i = base.lastIndexOf('.')
  return i < 0 ? '' : base.slice(i)
}

/** The basename without its extension. '/a/Rock.mat' -> 'Rock'. */
export function stemOf(path: string): string {
  const base = baseOf(path)
  const i = base.lastIndexOf('.')
  return i < 0 ? base : base.slice(0, i)
}

/** Join a folder and a basename into a path. joinPath('/', 'a.mat') -> '/a.mat'. */
export function joinPath(dir: string, base: string): string {
  return dir === '/' ? `/${base}` : `${dir}/${base}`
}

/** Every ancestor folder of a path, shallowest first. '/a/b/c.mat' -> ['/a', '/a/b']. */
export function ancestorsOf(path: string): string[] {
  const out: string[] = []
  const parts = path.split('/').filter(Boolean)
  parts.pop() // drop the basename
  let acc = ''
  for (const p of parts) {
    acc += `/${p}`
    out.push(acc)
  }
  return out
}

/** Close a folder list under its ancestors, deduped and sorted shallowest-first. Never includes '/'. */
export function withAncestors(folders: Iterable<string>): string[] {
  const set = new Set<string>()
  for (const f of folders) {
    if (!f || f === '/') continue
    set.add(f)
    for (const a of ancestorsOf(f)) set.add(a)
  }
  return Array.from(set).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
}

/** True when `path` is `folder` itself or lives anywhere beneath it. */
export function isUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === '/' ? '/' : `${folder}/`)
}

/**
 * Drop every id that is a descendant of another id in the same list.
 * SVAR's DataTree.remove throws if a batch names both a folder and something inside it.
 */
export function topMostIds(ids: string[]): string[] {
  const unique = Array.from(new Set(ids))
  return unique.filter(id => !unique.some(other => other !== id && isUnder(id, other)))
}

function depth(path: string): number {
  return path.split('/').filter(Boolean).length
}
