import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useDocument } from '../DocumentContext'
import { withSource } from '../../utils/textureAssets'
import type { TextureAsset, TextureSettings, TextureSource } from '../../utils/textureAssets'
import type { ImageAsset } from '../../utils/images'

// The texture editing session: one working copy of the open texture asset, shared by the 2D viewer in the
// viewport slot and the settings panel in Properties.
//
// It wraps the whole dock (Editor.tsx), like the tileset session, so either panel can be dragged anywhere
// without tying the working copy to one panel's mount.

type TextureContextValue = {
  /** The working copy, or null when no texture tab is active. */
  asset: TextureAsset | null
  /** The image asset behind it, when it has one. Null for a pack or a runtime texture. */
  image: ImageAsset | null
  /** Patch the sampling settings, mark the tab dirty, and retune the LIVE texture so the viewport follows. */
  patch: (p: Partial<TextureSettings>) => void
  /** Rename the working copy. */
  rename: (name: string) => void
  /** Re-point the texture at another image. */
  setSource: (source: TextureSource) => void
  save: () => void
  dirty: boolean
}

const TextureContext = createContext<TextureContextValue | null>(null)

export function useTexture(): TextureContextValue {
  const ctx = useContext(TextureContext)
  if (!ctx) throw new Error('useTexture must be used within a TextureProvider')
  return ctx
}

export function TextureProvider({ children }: { children: React.ReactNode }) {
  const {
    editingTextureId, textures, images, saveTexture, previewTextureSettings, activeTab,
    registerTextureApply,
  } = useCleoEngine()
  const { markTabDirty, dirtyTabs } = useDocument()

  const [asset, setAsset] = useState<TextureAsset | null>(null)
  const loadedIdRef = useRef<string | null>(null)

  // Adopt the tab's asset when it changes. Guarded on the id rather than on the library array, so saving —
  // which rewrites the library — does not discard the working copy still being edited.
  useEffect(() => {
    if (!editingTextureId) {
      loadedIdRef.current = null
      setAsset(null)
      return
    }
    if (loadedIdRef.current === editingTextureId) return
    const found = textures.find(t => t.id === editingTextureId)
    if (!found) return
    loadedIdRef.current = editingTextureId
    setAsset(structuredClone(found))
  }, [editingTextureId, textures])

  const tabId = activeTab.kind === 'texture' ? activeTab.id : null

  const image = useMemo(() => {
    if (!asset) return null
    const id = asset.source.kind === 'image' ? asset.source.imageId
             : asset.source.kind === 'pack' ? asset.source.bakedImageId
             : undefined
    return id ? images.find(i => i.id === id) ?? null : null
  }, [asset, images])

  const patch = useCallback((p: Partial<TextureSettings>) => {
    setAsset(prev => {
      if (!prev) return prev
      const next = { ...prev, settings: { ...prev.settings, ...p } }
      // Straight to the GPU, before the save. Sampling is the one thing about a texture you cannot judge
      // from a form field, so the viewport has to follow the control rather than the commit.
      previewTextureSettings(next)
      return next
    })
    if (tabId) markTabDirty(tabId, 'texture-edit')
  }, [tabId, markTabDirty, previewTextureSettings])

  const rename = useCallback((name: string) => {
    setAsset(prev => (prev ? { ...prev, name } : prev))
    if (tabId) markTabDirty(tabId, 'texture-edit')
  }, [tabId, markTabDirty])

  const setSource = useCallback((source: TextureSource) => {
    // withSource, not a spread: the duplicated `textureIds`/`imageIds` the reference walkers scan have to
    // be re-derived, or a bundle ships the bytes of the image this texture no longer reads.
    setAsset(prev => (prev ? withSource(prev, source) : prev))
    if (tabId) markTabDirty(tabId, 'texture-edit')
  }, [tabId, markTabDirty])

  const save = useCallback(() => { if (asset) saveTexture(asset) }, [asset, saveTexture])

  // Hand the save back to EngineContext so Ctrl+S, Save All and the close-tab prompt can reach the working
  // copy — they only know tab ids.
  useEffect(() => {
    if (!tabId) return
    registerTextureApply({ tabId, apply: save })
    return () => registerTextureApply(null)
  }, [tabId, save, registerTextureApply])

  const value = useMemo<TextureContextValue>(() => ({
    asset, image, patch, rename, setSource, save,
    dirty: !!(tabId && dirtyTabs[tabId]),
  }), [asset, image, patch, rename, setSource, save, tabId, dirtyTabs])

  return <TextureContext.Provider value={value}>{children}</TextureContext.Provider>
}
