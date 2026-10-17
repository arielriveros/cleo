import { useEffect, useMemo, useState } from 'react'
import { ModelNode, type Node } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useVfs } from '../assets/VfsContext'
import Collapsable from '../../components/Collapsable'
import { Button, Hint, cn } from '../../components/ui'
import { getMaterialIdsOf } from '../../utils/materials'
import { applyMoveOne, baseOf, dirOf, indexByAsset, uniquePath } from '../../utils/vfs'
import type { ModelPart } from '../../utils/models'

// The model tab's Parts: every mesh in the model, and every material sub-mesh of a merged mesh, each of
// which can be saved as a model of its own — as a copy, or extracted out of this one.

const HINT = 'Save as model copies a piece into a new model next to this one. Extract also removes it from this model — save this model afterwards to keep that.'

interface Row { key: string; part: ModelPart; label: string; detail: string; depth: number }

const tris = (n: number) => `${Math.floor(n / 3).toLocaleString()} tris`

export default function ModelPartsSection() {
  const { activeTab, modelSession, saveModelPart, editorScene, materials, eventEmitter } = useCleoEngine()
  const { vfs, setVfs } = useVfs()
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  // A saved part belongs beside the model it came from. It is MOVED there once the reconciler has filed it
  // (in the folder being browsed) — never by repointing the shared landing folder, which used to stay
  // pointed here and send every later import into this model's folder.
  const [placement, setPlacement] = useState<{ assetId: string; folder: string } | null>(null)
  useEffect(() => {
    if (!placement) return
    const entry = indexByAsset(vfs).get(placement.assetId)
    if (!entry) return // not filed yet; this runs again when it is
    setPlacement(null)
    if (dirOf(entry.path) === placement.folder) return
    setVfs(prev => {
      const taken = new Set<string>([...prev.entries.map(e => e.path), ...prev.folders])
      const dot = baseOf(entry.path).lastIndexOf('.')
      const name = baseOf(entry.path)
      const target = uniquePath(taken, placement.folder, dot > 0 ? name.slice(0, dot) : name, dot > 0 ? name.slice(dot) : '')
      return applyMoveOne(prev, entry.path, target)
    })
  }, [placement, vfs, setVfs])

  useEffect(() => {
    const bump = () => setVersion(v => v + 1)
    eventEmitter.on('SCENE_CHANGED', bump)
    return () => { eventEmitter.off('SCENE_CHANGED', bump) }
  }, [eventEmitter])

  const rows = useMemo<Row[]>(() => {
    const rootId = modelSession?.levelIds[0]
    const root = rootId ? editorScene?.getNodeById(rootId) : null
    if (!root) return []
    const out: Row[] = []
    const matName = (id: string | undefined, i: number) =>
      (id && materials.find(m => m.id === id)?.name) || `Sub-mesh ${i + 1}`
    const walk = (n: Node, depth: number) => {
      if (n.isEditorOwned) return
      if (n instanceof ModelNode && n.model) {
        const ranges = n.model.submeshes
        out.push({ key: n.id, part: { nodeId: n.id }, label: n.name || 'Mesh', depth,
          detail: tris(n.model.geometry.indices.length) + (ranges.length > 1 ? ` · ${ranges.length} materials` : '') })
        if (ranges.length > 1) {
          const ids = getMaterialIdsOf(n)
          ranges.forEach((r, i) => out.push({
            key: `${n.id}#${i}`, part: { nodeId: n.id, submesh: i }, label: matName(ids[i], i), depth: depth + 1,
            detail: tris(r.count),
          }))
        }
      }
      for (const c of n.children) walk(c, depth + (n instanceof ModelNode ? 1 : 0))
    }
    walk(root, 0)
    return out
    // `version` re-reads the live tab scene after any edit (an extract changes it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelSession, editorScene, materials, version])

  if (!modelSession) return null
  const meshRows = rows.filter(r => r.part.submesh === undefined)

  const run = async (row: Row, mode: 'copy' | 'extract') => {
    const source = activeTab.modelId ? indexByAsset(vfs).get(activeTab.modelId) : undefined
    setBusy(row.key)
    try {
      const id = await saveModelPart(row.part, mode)
      if (id && source) setPlacement({ assetId: id, folder: dirOf(source.path) })
    } finally { setBusy(null) }
  }

  // Extracting must leave something behind: the last mesh, or a merged mesh's last material, cannot go.
  const canExtract = (row: Row) => row.part.submesh !== undefined || meshRows.length > 1

  return (
    <Collapsable title='Parts' persistKey='model.parts' hint={HINT}
      badge={rows.length ? rows.length : undefined}>
      <div className='w-full p-2'>
        {modelSession.activeLevel !== 0 && (
          <Hint className='mb-1'>Showing the model's own parts (LOD0); the selected level is a preview of another model.</Hint>
        )}
        {rows.length === 0 ? (
          <Hint>This model has no meshes.</Hint>
        ) : rows.length === 1 ? (
          <Hint>One mesh with one material — nothing to split off. Merged imports list each material here.</Hint>
        ) : (
          <div className='flex flex-col'>
            {rows.map(row => (
              <div key={row.key}
                className='group flex items-center gap-1 py-0.5 rounded hover:bg-control'
                style={{ paddingLeft: 4 + row.depth * 12 }}>
                <div className='min-w-0 flex-1'>
                  <div className={cn('truncate text-ui', row.part.submesh !== undefined && 'text-muted')} title={row.label}>
                    {row.part.submesh !== undefined ? '◆ ' : ''}{row.label}
                  </div>
                  <div className='text-ui-xs text-dim'>{row.detail}</div>
                </div>
                <Button size='sm' variant='ghost' disabled={!!busy}
                  title='Save this piece as a new model; this model stays as it is'
                  onClick={() => run(row, 'copy')}>{busy === row.key ? '…' : 'Save as model'}</Button>
                <Button size='sm' variant='ghost' disabled={!!busy || !canExtract(row)}
                  title={canExtract(row) ? 'Save this piece as a new model and remove it from this one' : 'The last mesh cannot be extracted'}
                  onClick={() => run(row, 'extract')}>Extract</Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Collapsable>
  )
}
