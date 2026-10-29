import { useRef } from 'react';
import { Logger } from 'cleo';
import { startTask } from '../progress/progressStore';
import { KIND_LABEL, SCENE_TAB_ID } from '../engineContextTypes';
import type { EditorTab, SavingState, TabKind } from '../engineContextTypes';

/**
 * The saving slice, lifted out of EngineProvider verbatim.
 *
 * It owns the two "the session holds the working copy, call back into it" registration slots and the
 * re-entrancy flag, and it is the single runner every save entry point goes through. The per-kind save
 * functions stay in the provider (each one reaches deep into its own tab machinery) and are handed in.
 */
export function useSaving(deps: {
  tabsRef: React.MutableRefObject<EditorTab[]>;
  dirtyTabsRef: React.MutableRefObject<Record<string, boolean>>;
  activeTabIdRef: React.MutableRefObject<string>;
  setSavingState: React.Dispatch<React.SetStateAction<SavingState>>;
  saveCurrentScene: () => Promise<boolean>;
  saveTemplateTab: (tabId: string) => Promise<void>;
  saveModelTab: (tabId: string) => Promise<void>;
  saveMaterialTab: (tabId: string) => Promise<void>;
  saveTerrainMaterialTab: (tabId: string) => Promise<void>;
  saveScriptTab: (tabId: string) => void;
  /** Focus a tab. Saving a session tab that is not the active one goes through this — see `makeLive`. */
  setActiveTab?: (id: string) => void;
}) {
  const {
    tabsRef, dirtyTabsRef, activeTabIdRef, setSavingState,
    saveCurrentScene, saveTemplateTab, saveModelTab, saveMaterialTab, saveTerrainMaterialTab, saveScriptTab,
    setActiveTab,
  } = deps;

  // ---- Saving: one action per tab, plus Save All ------------------------------------------------

  // The live animation session's Apply, registered by StateMachineProvider — and by AnimationFieldProvider
  // for a field tab. Neither can be saved from here: both keep their working copy as React state inside
  // their own provider. Only the active tab ever has a session, so one slot is enough.
  const animationApplyRef = useRef<{ tabId: string; apply: () => void } | null>(null);
  const registerAnimationApply = (reg: { tabId: string; apply: () => void } | null) => { animationApplyRef.current = reg; };

  // Same arrangement for the tileset session: TilesetProvider keeps the working copy as its own React
  // state, so saving a tileset tab from here means calling back into it.
  const tilesetApplyRef = useRef<{ tabId: string; apply: () => void } | null>(null);
  const registerTilesetApply = (reg: { tabId: string; apply: () => void } | null) => { tilesetApplyRef.current = reg; };
  // Same handshake as the tileset above: the working copy lives in TextureProvider, and Ctrl+S / Save All /
  // the close-tab prompt only know tab ids, so the session hands its save back here.
  const textureApplyRef = useRef<{ tabId: string; apply: () => void } | null>(null);
  const registerTextureApply = (reg: { tabId: string; apply: () => void } | null) => { textureApplyRef.current = reg; };
  // And the same again for the sound sample session, whose working copy lives in SoundProvider.
  const soundApplyRef = useRef<{ tabId: string; apply: () => void } | null>(null);
  const registerSoundApply = (reg: { tabId: string; apply: () => void } | null) => { soundApplyRef.current = reg; };
  const aiBrainApplyRef = useRef<{ tabId: string; apply: () => void } | null>(null);
  const registerAiBrainApply = (reg: { tabId: string; apply: () => void } | null) => { aiBrainApplyRef.current = reg; };
  // ...and the particle session, whose working copy lives in ParticleEditorProvider.
  const particleSystemApplyRef = useRef<{ tabId: string; apply: () => void } | null>(null);
  const registerParticleSystemApply = (reg: { tabId: string; apply: () => void } | null) => { particleSystemApplyRef.current = reg; };
  // ...and the clip session, whose working copy lives in ClipProvider.
  const clipApplyRef = useRef<{ tabId: string; apply: () => void } | null>(null);
  const registerClipApply = (reg: { tabId: string; apply: () => void } | null) => { clipApplyRef.current = reg; };

  // ...and the rig session, whose working copy lives in RigProvider.
  const rigApplyRef = useRef<{ tabId: string; apply: () => void } | null>(null);
  const registerRigApply = (reg: { tabId: string; apply: () => void } | null) => { rigApplyRef.current = reg; };

  /**
   * Save one tab, whichever kind it is. Returns whether the tab came out clean — each save path clears the
   * tab's dirty flag on success and logs + returns early on failure, so the flag is the honest signal.
   */
  const saveTabById = async (tabId: string): Promise<boolean> => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab) return false;
    switch (tab.kind) {
      case 'scene': return await saveCurrentScene();
      case 'template': await saveTemplateTab(tabId); break;
      case 'model': await saveModelTab(tabId); break;
      case 'material': await saveMaterialTab(tabId); break;
      case 'terrainMaterial': await saveTerrainMaterialTab(tabId); break;
      case 'script': saveScriptTab(tabId); break;
      case 'tileset': {
        const session = tilesetApplyRef.current;
        if (!session || session.tabId !== tabId) return false;
        session.apply();
        break;
      }
      case 'texture': {
        const session = textureApplyRef.current;
        if (!session || session.tabId !== tabId) return false;
        session.apply();
        break;
      }
      case 'aiBrain': {
        const session = aiBrainApplyRef.current;
        if (!session || session.tabId !== tabId) return false;
        session.apply();
        break;
      }
      case 'particleSystem': {
        const session = particleSystemApplyRef.current;
        if (!session || session.tabId !== tabId) return false;
        session.apply();
        break;
      }
      case 'rig': {
        const session = rigApplyRef.current;
        if (!session || session.tabId !== tabId) return false;
        session.apply();
        break;
      }
      case 'soundSample': {
        const session = soundApplyRef.current;
        if (!session || session.tabId !== tabId) return false;
        session.apply();
        break;
      }
      case 'stateMachine':
      case 'animationField': {
        const reg = animationApplyRef.current;
        if (!reg || reg.tabId !== tabId) return false;
        // State machine: writes the machine onto the source model, dirtying ITS tab.
        // Animation field: writes the field asset to the library and re-embeds it where it is played.
        reg.apply();
        break;
      }
      case 'animation': {
        const session = clipApplyRef.current;
        if (!session || session.tabId !== tabId) return false;
        session.apply();
        break;
      }
    }
    return !dirtyTabsRef.current[tabId];
  };

  /** The registration slot each session kind's provider hands its Apply to. */
  const sessionSlot = (kind: TabKind): React.MutableRefObject<{ tabId: string } | null> | null => {
    switch (kind) {
      case 'stateMachine': case 'animationField': return animationApplyRef;
      case 'animation': return clipApplyRef;
      case 'rig': return rigApplyRef;
      case 'tileset': return tilesetApplyRef;
      case 'texture': return textureApplyRef;
      case 'soundSample': return soundApplyRef;
      case 'aiBrain': return aiBrainApplyRef;
      case 'particleSystem': return particleSystemApplyRef;
      default: return null;
    }
  };

  /**
   * Make a session tab's provider live, so its Apply can be called.
   *
   * A session keeps its working copy as React state in its provider, and only the ACTIVE tab has a live
   * session — so saving an inactive one (a Character Animation workspace saving all its parts, or Save
   * All) means focusing it and waiting for its provider to register. Resolves false on a timeout.
   */
  const makeLive = async (tabId: string): Promise<boolean> => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    const slot = tab ? sessionSlot(tab.kind) : null;
    if (!slot || slot.current?.tabId === tabId) return true;
    if (!setActiveTab) return false;
    setActiveTab(tabId);
    const deadline = performance.now() + 3000;
    while (slot.current?.tabId !== tabId) {
      if (performance.now() > deadline) return false;
      await new Promise(r => setTimeout(r, 16));
    }
    return true;
  };

  const savingRef = useRef(false);

  /**
   * The one save runner: drives `tabIds` sequentially, one progress step each, and owns `savingState`. Every
   * save entry point goes through here, so they cannot drift or nest tasks. Each step races a 15s timeout,
   * so a wedged serialize can never leave the UI stuck on "Saving…".
   */
  const runSave = async (tabIds: string[], title: string): Promise<boolean> => {
    if (savingRef.current || !tabIds.length) return false;
    const named = tabIds.map(id => ({ id, tab: tabsRef.current.find(t => t.id === id) }));
    savingRef.current = true;
    setSavingState('saving');
    const task = startTask({
      title,
      steps: named.map(n => ({ name: n.tab?.title ?? 'Asset', status: 'pending' as const })),
      cancellable: tabIds.length > 1,
    });
    let failed = 0;
    // Saving an inactive session tab focuses it (see makeLive); the user's tab is restored afterwards.
    const returnTo = activeTabIdRef.current;
    try {
      for (let i = 0; i < named.length; i++) {
        if (task.cancelled) {
          for (let j = i; j < named.length; j++) task.setStep(j, { status: 'skipped' });
          failed++;
          break;
        }
        task.setStep(i, { status: 'running', detail: named[i].tab ? KIND_LABEL[named[i].tab!.kind] : undefined });
        try {
          await makeLive(named[i].id);
          const ok = await Promise.race<boolean>([
            saveTabById(named[i].id),
            new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error('Save timed out')), 15000)),
          ]);
          task.setStep(i, ok ? { status: 'done', detail: 'Saved' } : { status: 'failed', error: 'Save failed' });
          if (!ok) failed++;
        } catch (e: any) {
          Logger.error(`Failed to save "${named[i].tab?.title}": ${e?.message || e}`, 'Editor');
          task.setStep(i, { status: 'failed', error: String(e?.message || e) });
          failed++;
        }
      }
      setSavingState(failed ? 'error' : 'saved');
      return failed === 0;
    } finally {
      if (activeTabIdRef.current !== returnTo && tabsRef.current.some(t => t.id === returnTo)) setActiveTab?.(returnTo);
      task.finish();
      savingRef.current = false;
      setTimeout(() => setSavingState('idle'), 2000);
    }
  };

  const saveActiveTab = async (): Promise<boolean> => {
    const tab = tabsRef.current.find(t => t.id === activeTabIdRef.current);
    if (!tab) return false;
    return runSave([tab.id], `Saving ${tab.title}`);
  };

  /**
   * Save every tab with unsaved edits. Order is load-bearing: animation applies first (applying is what
   * makes the source model's tab dirty), then leaf assets, then the models and templates that embed them,
   * then the scene — saveCurrentScene hashes referenced assets and must not hash one about to be rewritten.
   */
  const saveAll = async (): Promise<void> => {
    if (savingRef.current) return;

    const live = animationApplyRef.current;
    if (live && dirtyTabsRef.current[live.tabId]) live.apply();

    const ORDER: Record<TabKind, number> = {
      // A rig saves FIRST: models and animations reference it, so a rig written after them would leave
      // one pass reading a skeleton the other has already replaced.
      rig: 0,
      // ...and a clip after it, but still before anything that plays one: an `.anim` names its source rig,
      // and a clip resolved against a skeleton the other pass has already replaced retargets off the wrong
      // bind pose. Same tier is fine — the sort is stable, and `rig` is listed first.
      animation: 0,
      material: 0, terrainMaterial: 0, script: 0, stateMachine: 0, animationField: 0, tileset: 0, texture: 0,
      soundSample: 0, aiBrain: 0,
      // A leaf asset: an effect only names textures and models, never the other way round, and the scene
      // that embeds it saves last anyway — so the re-embed lands before the scene is hashed and written.
      particleSystem: 0,
      model: 1, template: 2, scene: 3,
    };
    // Snapshot taken up front, so the loop is finite by construction.
    const targets = tabsRef.current
      .filter(t => dirtyTabsRef.current[t.id])
      .sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
    if (!targets.length) return;
    await runSave(targets.map(t => t.id), `Saving ${targets.length} asset${targets.length === 1 ? '' : 's'}`);
  };

  const saveProjectToStorage = (): Promise<boolean> => runSave([SCENE_TAB_ID], 'Saving scene');

  return {
    registerAnimationApply, registerTilesetApply, registerTextureApply, registerSoundApply,
    registerAiBrainApply, registerParticleSystemApply, registerRigApply, registerClipApply, saveTabById, runSave,
    saveActiveTab, saveAll, saveProjectToStorage,
  };
}
