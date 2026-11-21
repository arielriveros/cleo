// The copies of a script's source a bundle carries besides the script asset itself, and how a folder settles them.
//
// A script asset's source is its .ts file. Bundles written by the example generators also put the source on every
// scene and template node that runs it (`script`), templates made in the editor keep a `scripts` map, and a
// variant's diff keeps the sources it patches. The editor never saves a scene node's copy (extractNodeState: the
// library is what Play runs), so a folder leaves those out and a reader puts them back from the library; the
// others are stored as they are (a scene records each template's hash), refreshed to the library's source.
//
// Pure: no DOM, engine or Electron. Used by the tools that write the shipped examples and by cleo/testing.

const DEFAULT_CLASS = /export\s+default\s+(?:abstract\s+)?class\s+(\w+)/

interface Copies {
  scenes?: Record<string, { scene?: any } | undefined>
  libraries?: { scripts?: { id: string; source: string; kind?: string }[]; templates?: any[] }
}

const scriptIdOf = (n: any): string | undefined => n?.variables?.__scriptId?.value

function* treeNodes(root: any): Generator<any> {
  if (!root || typeof root !== 'object') return
  yield root
  for (const c of root.children ?? []) yield* treeNodes(c)
}

/**
 * Point every copy of a script's source at the library's. A scene node's inline `script` is put back (`fill`) or
 * taken away; a template node's inline `script`, a template's `scripts` map and a variant diff's copies are
 * refreshed where they exist, never added or removed. Returns how many changed.
 */
export function settleScriptCopies(bundle: Copies, { fill }: { fill: boolean }): number {
  const byId = new Map((bundle.libraries?.scripts ?? []).map(s => [s.id, s]))
  const byClass = new Map<string, string>()
  for (const s of byId.values()) {
    const cls = DEFAULT_CLASS.exec(s.source ?? '')?.[1]
    if (cls) byClass.set(cls, s.source)
  }
  let changed = 0
  for (const s of Object.values(bundle.scenes ?? {})) {
    for (const n of treeNodes(s?.scene)) {
      const asset = byId.get(scriptIdOf(n) as string)
      if (!asset || asset.kind === 'module') continue
      if (fill) { if (n.script !== asset.source) { n.script = asset.source; changed++ } }
      else if ('script' in n) { delete n.script; changed++ }
    }
  }
  const refresh = (value: any): any => {
    if (typeof value === 'string') {
      const cls = DEFAULT_CLASS.exec(value)?.[1]
      const fresh = cls && byClass.get(cls)
      if (fresh && fresh !== value) { changed++; return fresh }
      return value
    }
    if (Array.isArray(value)) return value.map(refresh)
    if (value && typeof value === 'object') { for (const k of Object.keys(value)) value[k] = refresh(value[k]); return value }
    return value
  }
  for (const t of bundle.libraries?.templates ?? []) {
    const linked = new Map<string, { source: string }>()
    for (const n of treeNodes(t?.nodeJson)) {
      const asset = byId.get(scriptIdOf(n) as string)
      if (!asset) continue
      linked.set(n.id, asset)
      if (typeof n.script === 'string' && n.script !== asset.source) { n.script = asset.source; changed++ }
    }
    if (t?.variant?.diff) refresh(t.variant.diff)
    if (t?.scripts && typeof t.scripts === 'object') {
      for (const [nodeId, source] of Object.entries(t.scripts)) {
        const asset = linked.get(nodeId)
        if (asset && source !== asset.source) { t.scripts[nodeId] = asset.source; changed++ }
      }
    }
  }
  return changed
}
