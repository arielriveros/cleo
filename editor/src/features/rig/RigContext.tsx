import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useDocument } from '../DocumentContext'
import { withOverride, withoutOverrides, type RigAsset } from '../../utils/rigAssets'

// The rig authoring session: the working copy of the rig open in the active tab.
//
// Shaped like TilesetContext — an immutable working copy in React state, patched by the inspector and
// pushed to the library only on save. Routing every edit through `updateRig` instead would re-resolve every
// clip on every model built on the rig, on every keystroke.

type RigContextValue = {
  /** The rig being edited, or null when no rig tab is active. */
  asset: RigAsset | null
  /** Replace the working copy. Marks the tab dirty. */
  patch: (next: RigAsset) => void
  /** Re-point one source bone onto this rig; `undefined` clears the override. */
  setOverride: (sourceRigId: string, sourceName: string, targetName: string | null | undefined) => void
  /** Drop every correction for one source rig — back to the automatic match. */
  clearOverrides: (sourceRigId: string) => void
  save: () => void
  dirty: boolean
}

const RigContext = createContext<RigContextValue | null>(null)

export function useRig(): RigContextValue {
  const ctx = useContext(RigContext)
  if (!ctx) throw new Error('useRig must be used within a RigProvider')
  return ctx
}

export function RigProvider({ children }: { children: React.ReactNode }) {
  const { editingRigId, saveRig, registerRigApply, activeTab } = useCleoEngine()
  const { rigs } = useAssetLibrary()
  const { markTabDirty, dirtyTabs } = useDocument()

  const [asset, setAsset] = useState<RigAsset | null>(null)
  const loadedIdRef = useRef<string | null>(null)

  // Adopt the tab's rig when it CHANGES. Guarded on the id rather than the library array, so a save —
  // which rewrites the library — does not throw away the working copy that produced it.
  useEffect(() => {
    if (!editingRigId) { loadedIdRef.current = null; setAsset(null); return }
    if (loadedIdRef.current === editingRigId) return
    const found = rigs.find(r => r.id === editingRigId)
    if (!found) return
    loadedIdRef.current = editingRigId
    // Deep copy: the working copy must be detached from the library record it came from.
    setAsset(JSON.parse(JSON.stringify(found)))
  }, [editingRigId, rigs])

  const tabId = activeTab.kind === 'rig' ? activeTab.id : null

  /**
   * The rig as the inspector should see it: the working copy, but with `animationIds` read LIVE from the
   * library.
   *
   * Linking a clip goes through `linkAnimationToRig`, which writes the library immediately (it has to —
   * every character on the rig re-resolves its clips there and then). The working copy is adopted once per
   * tab and would not see that, so saving would write back a list captured before the link and silently
   * drop it. Ownership is split deliberately: the library owns the clip list, this session owns everything
   * the inspector edits.
   */
  const live = editingRigId ? rigs.find(r => r.id === editingRigId) : undefined
  const merged = useMemo(
    () => (asset ? { ...asset, animationIds: live?.animationIds ?? asset.animationIds } : null),
    [asset, live?.animationIds],
  )

  const patch = useCallback((next: RigAsset) => {
    setAsset(next)
    if (tabId) markTabDirty(tabId, 'rig-edit')
  }, [tabId, markTabDirty])

  const setOverride = useCallback((sourceRigId: string, sourceName: string, targetName: string | null | undefined) => {
    setAsset(prev => {
      if (!prev) return prev
      if (tabId) markTabDirty(tabId, 'rig-retarget')
      return withOverride(prev, sourceRigId, sourceName, targetName)
    })
  }, [tabId, markTabDirty])

  const clearOverrides = useCallback((sourceRigId: string) => {
    setAsset(prev => {
      if (!prev) return prev
      const next = withoutOverrides(prev, sourceRigId)
      if (next !== prev && tabId) markTabDirty(tabId, 'rig-retarget')
      return next
    })
  }, [tabId, markTabDirty])

  const save = useCallback(() => { if (merged) saveRig(merged) }, [merged, saveRig])

  // Register with the save orchestrator, so Ctrl+S and Save All reach this session.
  useEffect(() => {
    if (!tabId) return
    registerRigApply({ tabId, apply: save })
    return () => registerRigApply(null)
  }, [tabId, save, registerRigApply])

  const value = useMemo<RigContextValue>(
    () => ({ asset: merged, patch, setOverride, clearOverrides, save, dirty: !!(tabId && dirtyTabs[tabId]) }),
    [merged, patch, setOverride, clearOverrides, save, tabId, dirtyTabs],
  )

  return <RigContext.Provider value={value}>{children}</RigContext.Provider>
}
