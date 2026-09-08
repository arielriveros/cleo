import { useMemo, useState } from 'react'
import { Logger } from 'cleo'
import { useAssetGraph } from './assets/AssetGraphContext'
import { useDocument } from './DocumentContext'
import { useCleoEngine } from './EngineContext'
import { confirmDialog } from './dialogs/dialogStore'
import { iconFor } from './assets/assetKinds'
import { KIND_LABEL } from '../utils/vfs'
import { cn, hintClass } from '../components/ui'

// "A model you have placed changed underneath you" — the one propagation that has to ask before it runs.
//
// Everything else the reference graph propagates is applied in place and silently: a texture's settings
// reach the live TextureManager entry, a material is re-applied to the nodes wearing it. Re-instantiation
// is different in kind — it mints fresh node ids and drops per-instance state (animation state, transform
// deltas, authored variables) — so it waits for a click.
//
// ONE mount point, directly under the tab strip, rather than one per tab view: there are five full-panel
// tab kinds plus the viewport, and a banner missing from any of them is a silently stale editor.

export default function StaleDependencyBanner() {
  const { staleTabs, dismissStale } = useAssetGraph()
  const { activeTabId, activeTab, dirtyTabs } = useDocument()
  const { reloadTab } = useCleoEngine()
  const [busy, setBusy] = useState(false)

  const stale = staleTabs.get(activeTabId)

  const summary = useMemo(() => {
    if (!stale?.length) return ''
    const [first] = stale
    const rest = stale.length - 1
    const what = `${KIND_LABEL[first.kind as keyof typeof KIND_LABEL] ?? first.kind} changed`
    return rest > 0 ? `${what}, and ${rest} other${rest === 1 ? '' : 's'}` : what
  }, [stale])

  if (!stale?.length || !activeTab) return null

  const reload = async () => {
    if (busy) return
    // Reloading re-seeds this tab FROM the library, which is exactly what discards a working copy. The
    // session contexts guard against re-seeding on every library change precisely so a save cannot clobber
    // an in-progress edit; this is the deliberate, user-initiated exception, so it has to say so.
    if (dirtyTabs[activeTabId]) {
      const proceed = await confirmDialog({
        title: `Reload "${activeTab.title}"?`,
        message: 'This tab has unsaved changes. Reloading rebuilds it from the saved assets and discards them.',
        confirmLabel: 'Discard and reload',
      })
      if (!proceed) return
    }
    setBusy(true)
    try {
      await reloadTab(activeTabId)
      dismissStale(activeTabId)
    } catch (err) {
      Logger.error('Could not reload the tab: ' + err, 'Editor')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='h-[24px] shrink-0 flex items-center gap-2 px-2 bg-warning/10 border-b border-warning/40'>
      <img src={iconFor(stale[0].kind as any)} className='w-3.5 h-3.5 shrink-0' alt='' draggable={false} />
      <span className='min-w-0 truncate text-[11px] text-warning'>
        {summary} since this tab was opened
      </span>
      <span className={cn(hintClass, 'ml-auto shrink-0 hidden lg:inline')}>
        Placed copies are rebuilt from the asset
      </span>
      <button
        className='shrink-0 inline-flex items-center h-[18px] px-2 rounded text-[11px] font-semibold bg-warning text-black hover:opacity-90 disabled:opacity-50'
        onClick={reload}
        disabled={busy}
        title='Rebuild this tab from the saved assets'>
        Reload
      </button>
      <button
        className='shrink-0 inline-flex items-center h-[18px] px-2 rounded text-[11px] text-muted hover:text-fg hover:bg-control-hover'
        onClick={() => dismissStale(activeTabId)}
        title='Keep working with what is on screen'>
        Dismiss
      </button>
    </div>
  )
}
