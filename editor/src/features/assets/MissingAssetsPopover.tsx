import { useState } from 'react'
import { Logger } from 'cleo'
import { useVfs } from './VfsContext'
import { iconFor } from './assetKinds'
import { sizeOfAsset } from './assetKinds'
import { MissingAsset, OrphanEntry, KIND_LABEL, applyDelete, baseOf, restoreMissing } from '../../utils/vfs'
import { cn, hintClass, sectionTitleClass, valueClass } from '../../components/ui'

// The two-way audit between the asset libraries and the explorer.
//
// Assets that exist in a library but aren't showing — the case where a node's material dropdown lists a
// material the Assets tab doesn't have. Two distinct failures land here, and the panel names which one,
// because that is the part you cannot see from the outside:
//
//   no-entry     the VFS index never got an entry for it (reconcileVfs didn't index it)
//   not-in-tree  it HAS an entry, but the file manager's store isn't showing that path (a desync)
//
// Restore fixes the first by indexing the asset into the folder you're browsing. The second needs only a
// re-sync, which the store-sync effect does as soon as the index object identity changes.
//
// And the mirror image: entries whose asset is gone. Those draw nothing, so the only symptom is that the
// path stays reserved and a re-import of the same file silently arrives as "Rock (2)". They are normally
// collected by reconcileVfs's prune, but that is deliberately disarmed while a library could still be
// loading — including the case where you deleted your last asset — so they also get a manual sweep.

const REASON_TEXT: Record<MissingAsset['reason'], string> = {
  'no-entry': 'never indexed',
  'not-in-tree': 'indexed, but not shown',
}

export default function MissingAssetsPopover(
  { missing, orphans, onClose }: { missing: MissingAsset[]; orphans: OrphanEntry[]; onClose: () => void },
) {
  const { setVfs, landingFolderRef, depsRef } = useVfs()
  const [busy, setBusy] = useState(false)

  const restoreAll = () => {
    if (busy || missing.length === 0) return
    setBusy(true)
    const folder = landingFolderRef.current || '/'

    setVfs(prev => {
      let next = prev
      for (const m of missing)
        next = restoreMissing(next, m, folder, sizeOfAsset(m.kind, m.assetId, depsRef.current))
      // A new object identity even when nothing was indexed: that alone re-runs the store-sync effect,
      // which is exactly the fix for the 'not-in-tree' half.
      return next === prev ? { ...prev } : next
    })

    const indexed = missing.filter(m => m.reason === 'no-entry').length
    Logger.info(
      indexed
        ? `Restored ${indexed} asset${indexed === 1 ? '' : 's'} into ${folder}`
        : 'Re-synced the explorer',
      'Editor',
    )
    setBusy(false)
    onClose()
  }

  // Only the index is touched: the assets these point at are already gone, so there is nothing to delete
  // behind them — which is also why this can't go through the explorer's own delete action.
  const cleanOrphans = () => {
    if (busy || orphans.length === 0) return
    setBusy(true)
    const paths = orphans.map(o => o.path)
    setVfs(prev => applyDelete(prev, paths))
    Logger.info(`Removed ${paths.length} orphaned index ${paths.length === 1 ? 'entry' : 'entries'}`, 'Editor')
    setBusy(false)
    onClose()
  }

  return (
    <div className='absolute right-0 top-[22px] z-30 w-[300px] bg-surface-raised border border-border rounded shadow-lg'>
      <div className='px-3 py-2 border-b border-border flex items-center justify-between gap-2'>
        <span className={sectionTitleClass}>Explorer audit</span>
        <button className='text-dim hover:text-fg leading-none px-1' title='Close' onClick={onClose}>✕</button>
      </div>

      {missing.length === 0 && orphans.length === 0 ? (
        <div className={cn(hintClass, 'px-3 py-3')}>
          The explorer and your libraries agree — nothing missing, nothing orphaned.
        </div>
      ) : missing.length > 0 && (
        <>
          <div className='max-h-[240px] overflow-y-auto'>
            {missing.map(m => (
              <div key={`${m.kind}:${m.assetId}`} className='flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle last:border-b-0'>
                <img src={iconFor(m.kind)} className='w-3.5 h-3.5 shrink-0' alt='' draggable={false} />
                <div className='min-w-0 flex-1'>
                  <div className={cn(valueClass, 'truncate')} title={m.name}>{m.name}</div>
                  <div className={hintClass}>{KIND_LABEL[m.kind]} · {REASON_TEXT[m.reason]}</div>
                </div>
              </div>
            ))}
          </div>

          <div className='px-3 py-2 border-t border-border flex items-center justify-between gap-2'>
            <span className={hintClass}>Lands in the folder you're browsing</span>
            <button
              className='shrink-0 inline-flex items-center h-[20px] px-2 rounded text-[11px] font-semibold bg-primary hover:bg-primary-hover disabled:opacity-50'
              onClick={restoreAll}
              disabled={busy}>
              Restore all
            </button>
          </div>
        </>
      )}

      {orphans.length > 0 && (
        <>
          <div className='px-3 py-1.5 border-t border-border'>
            <span className={sectionTitleClass}>Orphaned entries</span>
          </div>
          <div className='max-h-[160px] overflow-y-auto'>
            {orphans.map(o => (
              <div key={o.path} className='flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle last:border-b-0'>
                <img src={iconFor(o.kind)} className='w-3.5 h-3.5 shrink-0' alt='' draggable={false} />
                <div className='min-w-0 flex-1'>
                  <div className={cn(valueClass, 'truncate')} title={o.path}>{baseOf(o.path)}</div>
                  <div className={hintClass}>{KIND_LABEL[o.kind]} · asset no longer exists</div>
                </div>
              </div>
            ))}
          </div>
          <div className='px-3 py-2 border-t border-border flex items-center justify-between gap-2'>
            <span className={hintClass}>Frees their names for re-import</span>
            <button
              className='shrink-0 inline-flex items-center h-[20px] px-2 rounded text-[11px] font-semibold bg-primary hover:bg-primary-hover disabled:opacity-50'
              onClick={cleanOrphans}
              disabled={busy}>
              Clean up
            </button>
          </div>
        </>
      )}
    </div>
  )
}
