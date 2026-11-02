import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { pinKey, useCreatorPins } from '../creator/creatorPins'
import type { AnimationAsset, StoredClip } from '../../utils/animationAssets'

// The Clip Player session: which `.anim` the active tab shows, and which of its clips is on screen.
//
// There is no working copy. The player edits nothing but a clip's events and root-motion flag, and those
// are written straight into the library record (features/animation/useClipEvents.ts) — so the asset here IS
// the library's, and the tab never has anything to save. Motion is authored in Cleo Creator.
//
// The SELECTED CLIP is view state, not part of any document: a `.anim` holds several clips and the tab
// addresses the asset.

type ClipContextValue = {
  /** The asset the active clip tab shows, or null when no clip tab is active (or it was deleted). */
  asset: AnimationAsset | null
  /** The clip on screen, or null when the asset has none. */
  clip: StoredClip | null
  clipName: string | null
  selectClip: (name: string) => void
  /** Cleo Creator owns the asset: the next sync replaces it, keeping only its clips' events. */
  creatorManaged: boolean
}

const ClipContext = createContext<ClipContextValue | null>(null)

export function useClip(): ClipContextValue {
  const ctx = useContext(ClipContext)
  if (!ctx) throw new Error('useClip must be used within a ClipProvider')
  return ctx
}

export function ClipProvider({ children }: { children: React.ReactNode }) {
  const { editingAnimationId } = useCleoEngine()
  const { animations } = useAssetLibrary()
  const pins = useCreatorPins()
  const [clipName, setClipName] = useState<string | null>(null)

  const asset = useMemo(
    () => (editingAnimationId ? animations.find(a => a.id === editingAnimationId) ?? null : null),
    [editingAnimationId, animations],
  )

  // Keep the selection while the asset still has that clip; otherwise fall back to its first. Keyed on the
  // clip NAMES, so an events edit (which replaces the asset object) never resets it.
  const names = asset?.clips.map(c => c.name).join('\n') ?? ''
  useEffect(() => {
    setClipName(prev => (asset && asset.clips.some(c => c.name === prev) ? prev : asset?.clips[0]?.name ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingAnimationId, names])

  // Re-resolved by NAME rather than held by reference: every write replaces the clip object.
  const clip = useMemo(
    () => (asset && clipName ? asset.clips.find(c => c.name === clipName) ?? null : null),
    [asset, clipName],
  )

  const creatorManaged = !!asset && pins.folders.has(pinKey('animation', asset.id))

  const value = useMemo<ClipContextValue>(
    () => ({ asset, clip, clipName, selectClip: setClipName, creatorManaged }),
    [asset, clip, clipName, creatorManaged],
  )

  return <ClipContext.Provider value={value}>{children}</ClipContext.Provider>
}
