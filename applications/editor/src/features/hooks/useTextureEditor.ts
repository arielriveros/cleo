import { Logger, TextureManager } from 'cleo';
import { cryptoRandomId } from '../../utils/ids';
import { toTextureConfig } from '../../utils/textureAssets';
import type { TextureAsset } from '../../utils/textureAssets';
import type { EditorTab } from '../engineContextTypes';

/**
 * The texture-tab slice, alongside `useTilesetEditor`.
 *
 * Like the tileset editor and unlike every other asset tab, this one owns NO scene: a texture is an image
 * and a set of sampling decisions, so there is no `tabRuntimeRef` entry, no throwaway `Scene` and no
 * renderer involvement. The working copy lives in `TextureProvider`; everything here is tab plumbing.
 */
export function useTextureEditor(deps: {
  texturesRef: React.MutableRefObject<TextureAsset[]>;
  tabsRef: React.MutableRefObject<EditorTab[]>;
  setTabs: React.Dispatch<React.SetStateAction<EditorTab[]>>;
  updateTextureAsset: (id: string, t: TextureAsset) => void;
  setActiveTab: (id: string) => void;
  commitTab: (tab: EditorTab, adoptTabId?: string) => void;
  clearTabDirty: (id: string) => void;
}) {
  const {
    texturesRef, tabsRef, setTabs, updateTextureAsset, setActiveTab, commitTab, clearTabDirty,
  } = deps;

  /**
   * Open, or focus, a texture's edit tab.
   *
   * There is no "create a new texture" path here, unlike the tileset editor's atlas-less start: a texture
   * with no bytes has nothing to sample and nothing to show. Textures come into being by importing an
   * image or by duplicating one — both of which mint the record through the asset reconciler.
   */
  const enterTextureEditor = (textureId?: string, adoptTabId?: string) => {
    const asset = textureId ? texturesRef.current.find(t => t.id === textureId) : undefined;
    if (!asset) { Logger.error('Texture not found', 'Editor'); return; }

    if (!adoptTabId) {
      const existing = tabsRef.current.find(t => t.kind === 'texture' && t.textureId === asset.id);
      if (existing) { setActiveTab(existing.id); return; }
    }
    const tabId = adoptTabId ?? cryptoRandomId();
    commitTab({ id: tabId, kind: 'texture', title: asset.name, textureId: asset.id }, adoptTabId);
  };

  /**
   * Persist an edited texture.
   *
   * The live GPU texture is retuned by `updateTextureAsset`, so the viewport follows a save without a
   * reload. Nothing is re-embedded anywhere: a material references a texture by id, and that id never
   * changes, which is the whole reason the split could leave the ~187 existing references alone.
   */
  const saveTexture = (asset: TextureAsset) => {
    updateTextureAsset(asset.id, asset);
    texturesRef.current = texturesRef.current.map(t => t.id === asset.id ? asset : t);
    const open = tabsRef.current.find(t => t.kind === 'texture' && t.textureId === asset.id);
    if (open) {
      clearTabDirty(open.id);
      if (open.title !== asset.name) setTabs(prev => prev.map(t => t.id === open.id ? { ...t, title: asset.name } : t));
    }
    Logger.info(`Texture "${asset.name}" saved`, 'Editor');
  };

  /**
   * Apply settings to the LIVE texture without touching the library — what the inspector calls while a
   * control is being dragged, so the viewport tracks the slider instead of jumping on save.
   */
  const previewTextureSettings = (asset: TextureAsset) => {
    TextureManager.Instance.getTexture(asset.id)?.applySettings(toTextureConfig(asset.settings));
  };

  return { enterTextureEditor, saveTexture, previewTextureSettings };
}
