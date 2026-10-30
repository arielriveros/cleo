import { Logger, AudioManager } from 'cleo';
import { cryptoRandomId } from '../../utils/ids';
import type { SoundSampleAsset } from '../../utils/soundSamples';
import type { EditorTab } from '../engineContextTypes';

/**
 * The sound-sample tab slice, the direct twin of `useTextureEditor`.
 *
 * Owns NO scene: a sample is a file plus a set of playback decisions, so there is no `tabRuntimeRef`
 * entry, no throwaway `Scene` and no renderer involvement. The working copy lives in `SoundProvider`;
 * everything here is tab plumbing.
 */
export function useSoundEditor(deps: {
  soundSamplesRef: React.MutableRefObject<SoundSampleAsset[]>;
  tabsRef: React.MutableRefObject<EditorTab[]>;
  setTabs: React.Dispatch<React.SetStateAction<EditorTab[]>>;
  updateSoundSample: (id: string, s: SoundSampleAsset) => void;
  setActiveTab: (id: string) => void;
  commitTab: (tab: EditorTab, adoptTabId?: string) => void;
  clearTabDirty: (id: string) => void;
}) {
  const {
    soundSamplesRef, tabsRef, setTabs, updateSoundSample, setActiveTab, commitTab, clearTabDirty,
  } = deps;

  /**
   * Open, or focus, a sample's edit tab.
   *
   * No "create a new sample" path, for the same reason the texture editor has none: a sample with no
   * audio has nothing to play and nothing to draw. Samples come into being by importing a file or by
   * duplicating one, and both mint the record through the asset reconciler.
   */
  const enterSoundEditor = (sampleId?: string, adoptTabId?: string) => {
    const asset = sampleId ? soundSamplesRef.current.find(s => s.id === sampleId) : undefined;
    if (!asset) { Logger.error('Sound sample not found', 'Editor'); return; }

    if (!adoptTabId) {
      const existing = tabsRef.current.find(t => t.kind === 'soundSample' && t.soundId === asset.id);
      if (existing) { setActiveTab(existing.id); return; }
    }
    const tabId = adoptTabId ?? cryptoRandomId();
    commitTab({ id: tabId, kind: 'soundSample', title: asset.name, soundId: asset.id }, adoptTabId);
  };

  /**
   * Persist an edited sample.
   *
   * The live Sound is retuned by `updateSoundSample`, so anything currently playing follows a save
   * without a reload. Nothing is re-embedded: a SoundNode references a sample by id, and that id never
   * changes — which is why renaming is free.
   */
  const saveSoundSample = (asset: SoundSampleAsset) => {
    updateSoundSample(asset.id, asset);
    soundSamplesRef.current = soundSamplesRef.current.map(s => s.id === asset.id ? asset : s);
    const open = tabsRef.current.find(t => t.kind === 'soundSample' && t.soundId === asset.id);
    if (open) {
      clearTabDirty(open.id);
      if (open.title !== asset.name) setTabs(prev => prev.map(t => t.id === open.id ? { ...t, title: asset.name } : t));
    }
    Logger.info(`Sound "${asset.name}" saved`, 'Editor');
  };

  /**
   * Apply settings to the LIVE sound without touching the library — what the settings panel calls while a
   * control is being dragged, so a playing preview tracks the slider instead of jumping on save.
   *
   * This is the whole reason `EffectRack` distinguishes `tune` from `rebuild`: reaching the graph on
   * every mousemove must not disconnect nodes under a sounding note.
   */
  const previewSoundSettings = (asset: SoundSampleAsset) => {
    AudioManager.Instance.applySettings(asset.id, asset.settings);
  };

  return { enterSoundEditor, saveSoundSample, previewSoundSettings };
}
