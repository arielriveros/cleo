import { useEffect, useMemo, useRef, useState } from 'react'
import { assetGraph, assetKey } from 'cleo'
import type { AssetRef } from 'cleo'
import { useVfs } from './VfsContext'
import { useCleoEngine } from '../EngineContext'
import { useAssetGraph } from './AssetGraphContext'
import { findAsset, iconFor, openAsset } from './assetKinds'
import { sceneRefsComplete } from '../../utils/assetEdges'
import { KIND_LABEL, baseOf } from '../../utils/vfs'
import type { AssetKind } from '../../utils/vfs'
import { buildReferenceView } from './assetGraphLayout'
import type { AssetNodeView } from './assetGraphLayout'
import AssetGraphCanvas from './AssetGraphCanvas'
import { Modal, cn, hintClass, sectionTitleClass } from '../../components/ui'

// The reference viewer. One asset in the middle, what uses it on the left, what it uses on the right.
//
// A MODAL rather than a dockview panel: a panel would need a LAYOUT_VERSION bump (so existing users' saved
// trees learn about it), a `hiddenPanelIds` entry and, to be reachable, a new EditorMode — a lot of
// permanent surface for a view that is opened from a toolbar button and dismissed.

/** How far to follow each side. Infinity is the whole closure. */
const DEPTHS: { label: string; value: number }[] = [
  { label: '1', value: 1 },
  { label: '2', value: 2 },
  { label: 'All', value: Infinity },
]

export default function AssetGraphModal({ onClose }: { onClose: () => void }) {
  const { vfs, libs, depsRef } = useVfs()
  const { openSceneId } = useCleoEngine()
  // Not read for its value — subscribing is what redraws the graph after a library edit.
  const { version, dangling } = useAssetGraph()

  const [root, setRoot] = useState<AssetRef | null>(null)
  const [referencerDepth, setReferencerDepth] = useState(1)
  const [referenceDepth, setReferenceDepth] = useState(2)
  const [search, setSearch] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  /** Every indexed asset, as a pickable row. The VFS gives both a display name and a stable path. */
  const catalog = useMemo(
    () => vfs.entries.map(e => ({ ref: { kind: e.kind, id: e.assetId } as AssetRef, path: e.path, name: baseOf(e.path) })),
    [vfs],
  )

  const nameOf = useMemo(() => (ref: AssetRef): string => {
    const asset = findAsset(ref.kind as AssetKind, ref.id, depsRef.current) as { name?: string } | undefined
    if (asset?.name) return asset.name
    // A dangling target has no record to name it, so fall back to the raw id — which is what the user
    // will have to search their project for.
    return ref.id
  }, [depsRef])

  const isPartial = useMemo(() => (ref: AssetRef): boolean => {
    if (ref.kind !== 'scene') return false
    // The OPEN scene's edges are re-derived live from the scene itself, so they are complete regardless of
    // what its last save recorded. Judging it by its stored `refs` would mark the one scene we know most
    // about as partial.
    if (ref.id === openSceneId) return false
    const meta = libs.scenes.find(s => s.id === ref.id) as { refs?: any } | undefined
    return !sceneRefsComplete(meta?.refs)
  }, [libs, openSceneId])

  // Seed on the first asset with references, so the view opens on something rather than an empty canvas.
  useEffect(() => {
    if (root) return
    const withEdges = catalog.find(c => assetGraph.outgoing(assetKey(c.ref.kind, c.ref.id)).length > 0)
    setRoot((withEdges ?? catalog[0])?.ref ?? null)
  }, [catalog, root])

  useEffect(() => {
    if (!pickerOpen) return
    const onDown = (e: PointerEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [pickerOpen])

  // Escape closes — the asset picker first if it is open, then the graph. Registered on the document
  // because focus is usually inside the react-flow canvas, which is not a child of any field we own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (pickerOpen) setPickerOpen(false)
      else onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pickerOpen, onClose])

  const view = useMemo(() => {
    if (!root) return { nodes: [], edges: [], missingCount: 0 }
    // `version` is in the dep list on purpose: the graph is a mutable singleton, so nothing else here
    // changes identity when an asset is edited.
    void version
    return buildReferenceView(assetGraph, root, { referencerDepth, referenceDepth, nameOf, isPartial })
  }, [root, referencerDepth, referenceDepth, nameOf, isPartial, version])

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = q ? catalog.filter(c => c.name.toLowerCase().includes(q)) : catalog
    return rows.slice(0, 60)
  }, [catalog, search])

  const rootKey = root ? assetKey(root.kind, root.id) : ''
  const referencers = view.nodes.filter(n => n.depth < 0).length
  const references = view.nodes.filter(n => n.depth > 0).length

  const open = (node: AssetNodeView) => {
    if (node.missing) return
    if (openAsset(node.ref.kind as AssetKind, node.ref.id, depsRef.current)) onClose()
  }

  return (
    <Modal onClose={onClose} className='w-[92vw] h-[86vh] max-h-[86vh] flex flex-col overflow-hidden overflow-y-hidden'>
      <div className='shrink-0 px-3 py-2 border-b border-border flex items-center gap-2'>
        <span className={sectionTitleClass}>Reference graph</span>

        {/* Root picker */}
        <div className='relative ml-2' ref={pickerRef}>
          <button
            className='inline-flex items-center gap-1.5 h-[22px] px-2 rounded bg-control border border-border text-[11px] hover:bg-control-hover'
            onClick={() => setPickerOpen(v => !v)}
            title='Choose the asset to centre the graph on'>
            {root && <img src={iconFor(root.kind as AssetKind)} className='w-3.5 h-3.5' alt='' draggable={false} />}
            <span className='max-w-[220px] truncate'>{root ? nameOf(root) : 'Pick an asset'}</span>
            <span className='text-[9px]'>▾</span>
          </button>
          {pickerOpen && (
            <div className='absolute left-0 top-[26px] z-30 w-[300px] bg-surface-raised border border-border rounded shadow-lg'>
              <input
                autoFocus
                className='w-full h-[24px] px-2 bg-control border-b border-border text-[11px] text-fg placeholder:text-dim focus:outline-none'
                placeholder='Search assets'
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <div className='max-h-[320px] overflow-y-auto'>
                {matches.map(m => (
                  <button
                    key={m.path}
                    className='w-full flex items-center gap-2 px-2 h-[24px] text-[11px] text-left hover:bg-selected/30'
                    onClick={() => { setRoot(m.ref); setPickerOpen(false); setSearch('') }}>
                    <img src={iconFor(m.ref.kind as AssetKind)} className='w-3.5 h-3.5 shrink-0' alt='' draggable={false} />
                    <span className='truncate'>{m.name}</span>
                  </button>
                ))}
                {!matches.length && <div className={cn(hintClass, 'px-2 py-2')}>No assets match.</div>}
              </div>
            </div>
          )}
        </div>

        <DepthPicker label='Referencers' value={referencerDepth} onChange={setReferencerDepth} count={referencers} />
        <DepthPicker label='References' value={referenceDepth} onChange={setReferenceDepth} count={references} />

        {dangling.length > 0 && (
          <span
            className='ml-2 shrink-0 inline-flex items-center h-[18px] px-2 rounded bg-danger-surface border border-danger-border text-[10px] text-danger'
            title='References pointing at an asset that no longer exists'>
            {dangling.length} broken reference{dangling.length === 1 ? '' : 's'}
          </span>
        )}

        <span className={cn(hintClass, 'ml-auto min-w-0 truncate hidden lg:inline')}>
          Click to re-centre · double-click to open
        </span>
        <button
          className='shrink-0 ml-auto lg:ml-0 inline-flex items-center gap-1 h-[22px] px-2 rounded bg-control border border-border text-[11px] text-muted hover:bg-control-hover hover:text-fg'
          onClick={onClose}
          title='Close the reference graph (Esc)'>
          <svg className='w-3 h-3' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round'>
            <path d='M6 6l12 12M18 6L6 18' />
          </svg>
          Close
        </button>
      </div>

      <div className='relative flex-1 min-h-0'>
        {/* Column captions, so the direction is readable before any edge is traced. */}
        <div className='absolute top-2 left-3 z-10 pointer-events-none text-[10px] text-dim'>
          ← used by
        </div>
        <div className='absolute top-2 right-3 z-10 pointer-events-none text-[10px] text-dim'>
          uses →
        </div>
        {root
          ? <AssetGraphCanvas view={view} rootKey={rootKey} onSelect={n => setRoot(n.ref)} onOpen={open} />
          : (
            <div className={cn(hintClass, 'w-full h-full flex items-center justify-center')}>
              This project has no assets yet.
            </div>
          )}
      </div>

      <div className='shrink-0 px-3 py-1.5 border-t border-border flex items-center gap-3'>
        <span className={hintClass}>
          {root ? `${KIND_LABEL[root.kind as AssetKind] ?? root.kind} · ${referencers} referencing · ${references} referenced` : ''}
        </span>
        {view.missingCount > 0 && (
          <span className='text-[11px] text-danger'>
            {view.missingCount} of these no longer exist
          </span>
        )}
      </div>
    </Modal>
  )
}

function DepthPicker(
  { label, value, onChange, count }: { label: string; value: number; onChange: (v: number) => void; count: number },
) {
  return (
    <div className='flex items-center gap-1 shrink-0'>
      <span className='text-[10px] text-dim'>{label}</span>
      <span className='text-[10px] text-muted tabular-nums'>({count})</span>
      <div className='flex items-center gap-0.5 p-[2px] rounded bg-surface border border-border-subtle'>
        {DEPTHS.map(d => (
          <button
            key={d.label}
            className={cn(
              'h-[16px] min-w-[20px] px-1 inline-flex items-center justify-center rounded-sm text-[10px]',
              value === d.value ? 'bg-selected text-white' : 'text-muted hover:bg-control-hover hover:text-fg',
            )}
            onClick={() => onChange(d.value)}
            title={`Follow ${d.label === 'All' ? 'every' : d.label} level`}>
            {d.label}
          </button>
        ))}
      </div>
    </div>
  )
}
