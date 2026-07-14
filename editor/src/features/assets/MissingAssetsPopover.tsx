import { useState } from 'react'
import { Logger } from 'cleo'
import { useVfs } from './VfsContext'
import { iconFor } from './assetKinds'
import { sizeOfAsset } from './assetKinds'
import { MissingAsset, KIND_LABEL, restoreMissing } from '../../utils/vfs'
import { cn, hintClass, sectionTitleClass, valueClass } from '../../components/ui'

// Assets that exist in a library but aren't showing in the explorer — the case where a node's material
// dropdown lists a material the Assets tab doesn't have. Two distinct failures land here, and the panel
// names which one, because that is the part you cannot see from the outside:
//
//   no-entry     the VFS index never got an entry for it (reconcileVfs didn't index it)
//   not-in-tree  it HAS an entry, but the file manager's store isn't showing that path (a desync)
//
// Restore fixes the first by indexing the asset into the folder you're browsing. The second needs only a
// re-sync, which the store-sync effect does as soon as the index object identity changes.

const REASON_TEXT: Record<MissingAsset['reason'], string> = {
  'no-entry': 'never indexed',
  'not-in-tree': 'indexed, but not shown',
}

export default function MissingAssetsPopover({ missing, onClose }: { missing: MissingAsset[]; onClose: () => void }) {
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

  return (
    <div className='absolute right-0 top-[22px] z-30 w-[300px] bg-surface-raised border border-border rounded shadow-lg'>
      <div className='px-3 py-2 border-b border-border flex items-center justify-between gap-2'>
        <span className={sectionTitleClass}>Missing from explorer</span>
        <button className='text-dim hover:text-fg leading-none px-1' title='Close' onClick={onClose}>✕</button>
      </div>

      {missing.length === 0 ? (
        <div className={cn(hintClass, 'px-3 py-3')}>
          Every asset in your libraries is showing in the explorer.
        </div>
      ) : (
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
    </div>
  )
}
