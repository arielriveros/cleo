import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DockviewApi,
  DockviewReact,
  DockviewReadyEvent,
  DockviewTheme,
  SerializedDockview,
} from 'dockview-react';
import { dockComponents, PanelTab } from './panels';
import { EditorMode, useCleoEngine } from '../EngineContext';
import { LS_KEYS, lsKey } from '../../utils/lsScope';
import './dockview.css';

// Per-project: a project's panel arrangement is part of how it is authored (a UI-heavy project wants a wide
// UI panel, a terrain project wants the landscape tools). Both live keys are resolved through lsScope, so
// deleting a project takes them with it.
const dockLayoutKey = () => lsKey(LS_KEYS.dockLayout);
// Pre-dockview layout blob ({ barsDimensions, bottomTab }); removed once on startup.
const OLD_LAYOUT_KEY = 'cleo_project_layout';
// v1 grouped Scene/UI under one "explorer" panel and Properties/Scripts/Physics under one
// "inspector" panel; v2 promoted all five to panels of their own. v3 adds the three animation panels;
// v4 adds the Animation Field panel. A restored older blob simply has no record of them, so those panels
// would never exist. Every version bump here discards saved arrangements on purpose: a stale layout cannot
// gain a panel it has never heard of.
//
// v5 changes the SHAPE rather than the panel set: one layout per editor mode instead of a single tree that
// was hidden and reconstituted (see LayoutStore).
//
// v7 adds the Profiler panel, kept out of CHROME_PANELS so it survived into renderer mode and Play.
// SUPERSEDED by v9, which makes it renderer-mode-only — see hiddenPanelIds.
//
// v8 replaces the old 'ui' panel (the legacy DOM-overlay inspector) with 'uiAdd', the UI element palette
// for the new `ui` mode. UI elements are scene nodes now, so the Scene tree and the ordinary Properties
// inspector cover everything the old panel did.
//
// v9 splits the Add palette out of the Scene panel into its own group: the left rail is now a
// `Scene Elements | UI Elements` tab pair above a Scene panel that holds the tree alone. It also makes the
// Profiler renderer-mode-only (see hiddenPanelIds), deliberately dropping the v7 arrangement that kept
// it visible during Play.
const OLD_DOCK_LAYOUT_KEYS = [
  'cleo_dock_layout_v1', 'cleo_dock_layout_v2', 'cleo_dock_layout_v3', 'cleo_dock_layout_v4',
  'cleo_dock_layout_v5', 'cleo_dock_layout_v6', 'cleo_dock_layout_v7', 'cleo_dock_layout_v8',
];
const LAYOUT_VERSION = 9;

/**
 * One saved arrangement per editor mode.
 *
 * Until v5 there was a single stored tree plus a "stash": entering a mode snapshotted the full layout, closed
 * the panels that mode forbids, and muted persistence until the restriction lifted. That was load-bearing and
 * broken at the same time. `hiddenPanelIds` never returns an empty list for ANY mode (scene mode still hides
 * the four animation panels), so the mute was permanent: the debounced writer below never ran, and the only
 * remaining write re-saved the stash it had just restored. The stored layout was frozen at whatever was in
 * localStorage when the editor booted, and no drag or resize ever reached it.
 *
 * Per-mode layouts delete the problem instead of patching it: nothing is ever mutilated, so nothing has to be
 * reconstituted, and each mode's tree is both authored and saved directly. It also buys a feature — the
 * animation editor's Clips/Variables/State Machine strip no longer has to share a width with the scene
 * editor's Properties panel.
 *
 * There is deliberately no key for play. Play is a restriction applied ON TOP of a mode
 * (hiddenPanelIds(mode, true) closes everything but the viewport), and play always runs in scene mode, so a
 * play entry would just be a viewport-only tree saved over and over. Instead nothing is saved while playing
 * and Stop restores `layouts[mode]` — which is exactly what the user had.
 *
 * v6 adds the two tilemap panels (Tiles + Layers). Same rule as every earlier bump: a stored v5 tree has
 * never heard of them, so it is discarded rather than patched.
 */
type LayoutStore = { version: typeof LAYOUT_VERSION; layouts: Partial<Record<EditorMode, SerializedDockview>> };

/**
 * Which of the stacked bottom panels the user last chose, tracked outside the dockview layout blob.
 *
 * It cannot live in the blob alone. Almost every mode "restricts" the layout (all but animation mode hide
 * the three animation panels), and while a restriction is applied layout changes are deliberately not
 * persisted — the restricted arrangement is meant to be discarded. So a bottom-tab switch made in any
 * normal mode was thrown away, and the next mode change restored the stash taken *before* it, snapping the
 * user back to whichever tab was active then — usually Logger, the default. Keeping the choice here means
 * it survives the stash/restore cycle, the buildDefaultLayout fallback, and a reload.
 */
const bottomTabKey = () => lsKey(LS_KEYS.dockBottomTab);
const BOTTOM_PANELS = ['logger', 'assets'] as const;
type BottomPanel = (typeof BOTTOM_PANELS)[number];

function loadBottomTab(): BottomPanel {
  try {
    const v = localStorage.getItem(bottomTabKey());
    if (v && (BOTTOM_PANELS as readonly string[]).includes(v)) return v as BottomPanel;
  } catch { /* ignore */ }
  return 'logger';
}

/**
 * Which bottom tab is currently selected, or null when the mode hides them both.
 *
 * Read from the group's own `activePanel` rather than `panel.api.isVisible`: both bottom panels are
 * `renderer: 'always'` (so the hidden one stays mounted and keeps its state), which means visibility does
 * not track tab selection for them the way it does for ordinary panels.
 */
function activeBottomTab(dock: DockviewApi): BottomPanel | null {
  for (const id of BOTTOM_PANELS) {
    const selected = dock.getPanel(id)?.group?.activePanel?.id;
    if (selected && (BOTTOM_PANELS as readonly string[]).includes(selected)) return selected as BottomPanel;
  }
  return null;
}

/** Animation-editor panels. Present in every layout, shown only in animation mode — see hiddenPanelIds. */
const ANIMATION_PANELS = ['animClips', 'animVariables', 'animStateMachine'] as const;

/** Animation-field panels. Same arrangement, for animationField mode. */
const ANIMATION_FIELD_PANELS = ['animField'] as const;

/** Tilemap-editor panels: the tile palette and the layer stack. Shown only in tilemap mode. */
const TILEMAP_PANELS = ['tilePalette', 'tilemapLayers'] as const;

/**
 * The two Add palettes, stacked as tabs above the Scene tree.
 *
 * Unlike the mode-specific groups above, these are ordinary chrome: both are available wherever the tree
 * is, so a HUD element and a mesh are added from the same place rather than one being reachable only from
 * `ui` mode.
 */
const ADD_PANELS = ['sceneAdd', 'uiAdd'] as const;

const CHROME_PANELS = [
  'scene', 'properties', 'scripts', 'physics', 'logger', 'assets',
  ...ANIMATION_PANELS, ...ANIMATION_FIELD_PANELS, ...TILEMAP_PANELS, ...ADD_PANELS,
] as const;

// The Scene panel hosts the mode-specific tree (there is no separate dock panel for it), so its tab label
// follows the mode. The animation editor's own panels are real panels with fixed titles.
const PANEL_TITLES: Record<string, string> = {
  viewport: 'Viewport', scene: 'Scene', sceneAdd: 'Scene Elements', uiAdd: 'UI Elements', properties: 'Properties',
  scripts: 'Scripts', physics: 'Physics', logger: 'Logger', assets: 'Assets',
  animClips: 'Clips', animVariables: 'Variables', animStateMachine: 'State Machine',
  animField: 'Blend Space',
  tilePalette: 'Tiles', tilemapLayers: 'Layers',
  profiler: 'Profiler',
};

function panelTitle(id: string, mode: EditorMode): string {
  if (id === 'scene' && mode === 'animation') return 'Skeleton';
  if (id === 'properties') {
    if (mode === 'material') return 'Material';
    if (mode === 'terrainMaterial') return 'Terrain Material';
    if (mode === 'tileset') return 'Tileset';
  }
  return PANEL_TITLES[id];
}

const cleoTheme: DockviewTheme = { name: 'cleo', className: 'dockview-theme-cleo', colorScheme: 'dark' };

// The viewport is the immovable center anchor: no tab header (so it can't be dragged, floated or
// closed) and no dropping *into* it — edge drops beside it still work, so panels can dock around.
// Returns false when the panel is missing, which marks a restored layout as corrupt.
function assertViewportLock(api: DockviewApi): boolean {
  const vp = api.getPanel('viewport');
  if (!vp) return false;
  vp.group.locked = true;
  vp.group.header.hidden = true;
  return true;
}

// Scene/UI stacked as tabs 20vw left, Properties/Scripts/Physics stacked as tabs 25vw right,
// Logger/Assets stacked in a 30vh strip under the viewport only (between the sidebars). Every panel
// is free to be dragged out of its group and re-docked anywhere.
function buildDefaultLayout(api: DockviewApi) {
  api.clear();
  const width = api.width || window.innerWidth;
  const height = api.height || window.innerHeight;
  api.addPanel({ id: 'viewport', component: 'viewport', title: 'Viewport', renderer: 'always' });
  const scene = api.addPanel({
    id: 'scene', component: 'scene', title: 'Scene',
    position: { referencePanel: 'viewport', direction: 'left' },
    initialWidth: Math.round(width * 0.20),
  });
  // The palettes sit in their own group ABOVE the tree, as a `Scene Elements | UI Elements` tab pair, so
  // the tree stays visible while either palette is in use — the whole point of UI elements being nodes.
  // This is the only place a non-viewport panel is split rather than tabbed.
  api.addPanel({
    id: 'sceneAdd', component: 'sceneAdd', title: PANEL_TITLES['sceneAdd'],
    position: { referencePanel: 'scene', direction: 'above' },
    initialHeight: Math.round(height * 0.34),
  });
  api.addPanel({
    id: 'uiAdd', component: 'uiAdd', title: PANEL_TITLES['uiAdd'],
    position: { referencePanel: 'sceneAdd', direction: 'within' },
  });
  const properties = api.addPanel({
    id: 'properties', component: 'properties', title: 'Properties',
    position: { referencePanel: 'viewport', direction: 'right' },
    initialWidth: Math.round(width * 0.25),
  });
  api.addPanel({
    id: 'scripts', component: 'scripts', title: 'Scripts',
    position: { referencePanel: 'properties', direction: 'within' },
  });
  api.addPanel({
    id: 'physics', component: 'physics', title: 'Physics',
    position: { referencePanel: 'properties', direction: 'within' },
  });
  // The animation panels share the Properties tab strip. They are hidden everywhere but animation mode,
  // where Properties itself is hidden — so the strip reads as Clips | Variables | State Machine there.
  for (const id of [...ANIMATION_PANELS, ...ANIMATION_FIELD_PANELS, ...TILEMAP_PANELS]) {
    api.addPanel({
      id, component: id, title: PANEL_TITLES[id],
      position: { referencePanel: 'properties', direction: 'within' },
    });
  }
  // Docked with Properties on the right rail: it is a tall column of sections, which suits that
  // rail's proportions, and it is NOT in CHROME_PANELS so it survives into Play and renderer mode
  // where the rest of that tab strip is hidden.
  api.addPanel({
    id: 'profiler', component: 'profiler', title: PANEL_TITLES['profiler'],
    position: { referencePanel: 'properties', direction: 'within' },
  });
  scene.api.setActive();
  properties.api.setActive();
  // Logger and Assets keep renderer:'always' so the hidden tab stays in the DOM: unmounting the
  // asset explorer would tear down the SVAR store + drag patch and lose the folder being browsed.
  const logger = api.addPanel({
    id: 'logger', component: 'logger', title: 'Logger', renderer: 'always',
    position: { referencePanel: 'viewport', direction: 'below' },
    initialHeight: Math.round(height * 0.30),
  });
  const assets = api.addPanel({
    id: 'assets', component: 'assets', title: 'Assets', renderer: 'always',
    position: { referencePanel: 'logger', direction: 'within' },
  });
  // Honour the remembered bottom tab. This function is also the fallback whenever restoring a stashed
  // layout fails, so hardcoding Logger here was one of the ways the user's choice got thrown away.
  (loadBottomTab() === 'assets' ? assets : logger).api.setActive();
  assertViewportLock(api);
}

/**
 * Re-assert `renderer: 'always'` on the panels that require it.
 *
 * buildDefaultLayout sets it at creation, but a restored blob is not guaranteed to carry it (and one written
 * by an older build certainly won't). The default, 'onlyWhenVisible', unmounts a panel whenever its tab is
 * not selected — which for `assets` tears down the SVAR store, the drag patch and the folder the user was
 * browsing, and for `viewport` tears down the WebGL canvas host.
 */
function assertRenderers(api: DockviewApi) {
  for (const id of ['viewport', 'logger', 'assets']) {
    const panel = api.getPanel(id);
    if (panel && panel.api.renderer !== 'always') panel.api.setRenderer('always');
  }
}

function loadLayouts(): LayoutStore['layouts'] {
  try {
    const raw = localStorage.getItem(dockLayoutKey());
    if (!raw) return {};
    const saved = JSON.parse(raw) as LayoutStore;
    if (saved?.version !== LAYOUT_VERSION || !saved.layouts) return {};
    return saved.layouts;
  } catch {
    return {};
  }
}

/** Store the current tree as `mode`'s arrangement, leaving every other mode's untouched. */
function saveLayoutFor(api: DockviewApi, mode: EditorMode) {
  try {
    const store: LayoutStore = { version: LAYOUT_VERSION, layouts: { ...loadLayouts(), [mode]: api.toJSON() } };
    localStorage.setItem(dockLayoutKey(), JSON.stringify(store));
  } catch { /* quota or a serialization failure — a lost arrangement is not worth breaking the editor */ }
}

function clearLayouts() {
  try { localStorage.removeItem(dockLayoutKey()); } catch { /* ignore */ }
}

/**
 * Force a layout pass after rebuilding the tree programmatically.
 *
 * `renderer: 'always'` panels (viewport, logger, assets) are not laid out by normal flow — dockview positions
 * their DOM from a layout pass. Tearing the tree down and re-adding panels in the same tick leaves those
 * positions stale, so the canvas and the console come back blank until something else triggers a measure —
 * which is why dragging a sidebar "fixed" it. Deferred a frame so the new groups have been measured first.
 */
function relayout(api: DockviewApi) {
  requestAnimationFrame(() => {
    const w = api.width || window.innerWidth;
    const h = api.height || window.innerHeight;
    try { api.layout(w, h, true); } catch { /* ignore */ }
  });
}

/**
 * Which panels a given mode / play state hides.
 *
 * Accumulated into a Set rather than returned from per-mode branches. The branch form carried a standing
 * hazard its own comment warned about: the fallthrough showed everything, so a mode-specific group had to
 * be spread into EVERY hand-built branch or it leaked into unrelated modes — which it did, three times,
 * when the UI panels were added. Here a group is hidden once, by default, and a mode opts out.
 */
function hiddenPanelIds(mode: EditorMode, playing: boolean): readonly string[] {
  // Renderer mode is the Profiler's one home, so it is the only branch that does not hide it.
  if (mode === 'renderer') return CHROME_PANELS;
  // Play strips the chrome AND the Profiler. This deliberately reverses the v7 arrangement (which kept the
  // Profiler through Play so it could measure the running game) — renderer mode is now its only home.
  if (playing) return [...CHROME_PANELS, 'profiler'];

  const hidden = new Set<string>(['profiler']);

  // Mode-specific panels: hidden everywhere, revealed by the single mode that owns them.
  if (mode !== 'animation') for (const id of ANIMATION_PANELS) hidden.add(id);
  if (mode !== 'animationField') for (const id of ANIMATION_FIELD_PANELS) hidden.add(id);
  if (mode !== 'tilemap') for (const id of TILEMAP_PANELS) hidden.add(id);

  const hide = (...ids: readonly string[]) => { for (const id of ids) hidden.add(id); };

  switch (mode) {
    // The scene tab and a template both author a node tree: everything applies.
    case 'scene':
    case 'template':
      break;
    // A screen rect has no rigid body.
    case 'ui':
      hide('physics');
      break;
    // Landscape and tilemap keep the tree and Properties — props are placed alongside the terrain/tiles,
    // and the node inspector is where a terrain's size and heightmap live.
    case 'landscape':
    case 'tilemap':
      hide('scripts', 'physics');
      break;
    // A mesh tab is a read-only preview: keep the tree + Properties to inspect the subtree, but there is
    // nothing to add to it.
    case 'model':
      hide(...ADD_PANELS, 'scripts', 'physics');
      break;
    // Animation brings its own three panels, so Properties has nothing left to host and the Scene panel
    // becomes the skeleton tree (retitled by panelTitle).
    case 'animation':
      hide(...ADD_PANELS, 'scripts', 'physics', 'properties');
      break;
    // A field tab previews one model and edits one asset: its own panel is the only inspector that applies.
    case 'animationField':
      hide(...ADD_PANELS, 'scene', 'scripts', 'physics', 'properties');
      break;
    // Asset editors: Properties hosts the asset's own inspector, and there is no scene to browse.
    case 'material':
    case 'terrainMaterial':
    case 'tileset':
      hide(...ADD_PANELS, 'scene', 'scripts', 'physics');
      break;
    // A script tab is a pure code editor rendered over the viewport.
    case 'script':
      hide(...ADD_PANELS, 'scene', 'properties', 'scripts', 'physics');
      break;
  }

  return [...hidden];
}

export default function DockLayout() {
  const { eventEmitter, editorMode, isPlayMode } = useCleoEngine();
  const [api, setApi] = useState<DockviewApi | null>(null);
  // Which mode's arrangement the live tree currently IS, and whether it is a play restriction. Both are the
  // controller's own memory of the last commit, not derived state: the effect needs the OUTGOING mode to
  // know which key to save the tree under before it swaps trees.
  const keyRef = useRef<EditorMode | null>(null);
  const playingRef = useRef(false);
  const bottomTabRef = useRef<BottomPanel>(loadBottomTab());
  // Non-zero while a layout pass we initiated is in flight. Tearing the tree down and rebuilding it emits
  // a burst of layout events in which the bottom group transiently reports whichever tab happens to be
  // first — so without this the remembered choice is overwritten by the very churn it exists to survive,
  // and the restore below then faithfully restores the wrong tab.
  const programmaticLayoutRef = useRef(0);

  /** Run a programmatic layout change with bottom-tab tracking muted until its events have settled. */
  const withProgrammaticLayout = useCallback((fn: () => void) => {
    programmaticLayoutRef.current++;
    try { fn(); } finally {
      // relayout() defers a frame, so the trailing events arrive after this call returns.
      requestAnimationFrame(() => requestAnimationFrame(() => { programmaticLayoutRef.current--; }));
    }
  }, []);

  /**
   * Put the remembered bottom tab back if a layout pass moved it. Deliberately a no-op when it is already
   * showing, or when the mode hides it entirely: `setActive` also takes global focus, and stealing that
   * on every mode switch would be worse than the problem being fixed.
   */
  const restoreBottomTab = useCallback((dock: DockviewApi) => {
    const want = bottomTabRef.current;
    const panel = dock.getPanel(want);
    if (panel && activeBottomTab(dock) !== want) panel.api.setActive();
  }, []);

  // Nothing but legacy cleanup: the mode controller below owns every path that builds a tree, and it runs
  // immediately after this because `editorMode` is already correct on the first render (the tab state that
  // derives it is restored synchronously). Building here as well would only build the wrong mode's layout
  // first and throw it away.
  const onReady = (event: DockviewReadyEvent) => {
    try { localStorage.removeItem(OLD_LAYOUT_KEY); } catch { /* ignore */ }
    for (const key of OLD_DOCK_LAYOUT_KEYS) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    }
    setApi(event.api);
  };

  // Persist the current mode's arrangement (debounced). Muted only while playing — play is a transient
  // restriction, not an arrangement worth remembering. Unlike the old `restrictedRef`, this mute actually
  // toggles, so a drag or resize made in any ordinary mode is now saved.
  useEffect(() => {
    if (!api) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      const mode = keyRef.current;
      if (playingRef.current || !mode) return;
      saveLayoutFor(api, mode);
    };
    const disposable = api.onDidLayoutChange(() => {
      clearTimeout(timer);
      timer = setTimeout(flush, 300);
    });
    // A drag finished inside the debounce window would otherwise be lost to a reload — which is exactly the
    // "my layout didn't survive" case this is all for. localStorage is synchronous, so a flush here lands.
    window.addEventListener('beforeunload', flush);
    return () => { clearTimeout(timer); disposable.dispose(); window.removeEventListener('beforeunload', flush); };
  }, [api]);

  /**
   * Retitle for the mode and close the panels it forbids. Every path that produces a full layout has to run
   * this — the mode effect below AND Reset Layout, which builds one from scratch while the mode is unchanged
   * and so cannot rely on that effect firing.
   */
  const applyRestriction = useCallback((dock: DockviewApi) => {
    for (const id of Object.keys(PANEL_TITLES)) dock.getPanel(id)?.api.setTitle(panelTitle(id, editorMode));
    for (const id of hiddenPanelIds(editorMode, isPlayMode)) dock.getPanel(id)?.api.close();
  }, [editorMode, isPlayMode]);

  // Mode/play controller. One path serves mode->mode, mode->play and play->mode: bank the outgoing mode's
  // arrangement, put the incoming mode's tree up, then restrict it.
  //
  // A saved tree already has the mode's forbidden panels closed, so applyRestriction is usually a no-op on
  // it — but it still has to run, because it is also what turns a freshly built all-panels default into
  // *this* mode's default, what expresses play, and what repairs a tree written by a build with a different
  // panel set. `close()` on a missing panel is a no-op, so re-asserting costs nothing.
  useEffect(() => {
    if (!api) return;
    const prev = keyRef.current;
    const wasPlaying = playingRef.current;
    withProgrammaticLayout(() => {
      // Never bank a play tree: it is viewport-only and would overwrite the real arrangement.
      if (prev && !wasPlaying) saveLayoutFor(api, prev);

      const saved = loadLayouts()[editorMode];
      let restored = false;
      if (saved) {
        try {
          // reuseExistingPanels keeps each panel's React subtree mounted across the swap. Without it the
          // viewport unmounts and remounts on every mode switch, re-parenting the WebGL canvas each time.
          api.fromJSON(saved, { reuseExistingPanels: true });
          restored = assertViewportLock(api);
        } catch { restored = false; }
      }
      if (!restored) buildDefaultLayout(api);

      assertRenderers(api);
      applyRestriction(api);
      // fromJSON restores whichever bottom tab was selected when the tree was saved — put the user's
      // last actual choice back.
      restoreBottomTab(api);
      relayout(api); // opening/closing panels moves the always-rendered viewport and logger
    });
    keyRef.current = editorMode;
    playingRef.current = isPlayMode;
  }, [api, editorMode, isPlayMode, applyRestriction, restoreBottomTab, withProgrammaticLayout]);

  // Remember which bottom tab the user is on. When a mode hides both panels there is no selection to read,
  // so the remembered value is left alone rather than being overwritten by a mode that shows neither.
  useEffect(() => {
    if (!api) return;
    const sync = () => {
      if (programmaticLayoutRef.current > 0) return; // mid-rebuild: the reported selection is transient
      const current = activeBottomTab(api);
      if (!current || current === bottomTabRef.current) return;
      bottomTabRef.current = current;
      try { localStorage.setItem(bottomTabKey(), current); } catch { /* ignore */ }
    };
    sync();
    const disposables = [api.onDidLayoutChange(sync), api.onDidActivePanelChange(sync)];
    return () => { disposables.forEach(d => d.dispose()); };
  }, [api]);

  // "New asset" flows focus the Assets tab (legacy per-kind tab names all meant Assets).
  useEffect(() => {
    if (!api) return;
    const onFocus = (tab: unknown) => {
      // A programmatic focus is still the tab the user ends up on, so it becomes the remembered one —
      // the layout listener would catch it anyway, this just avoids depending on that ordering.
      const id: BottomPanel = tab === 'Logger' ? 'logger' : 'assets';
      bottomTabRef.current = id;
      try { localStorage.setItem(bottomTabKey(), id); } catch { /* ignore */ }
      api.getPanel(id)?.api.setActive();
    };
    eventEmitter.on('FOCUS_BOTTOM_TAB', onFocus);
    return () => { eventEmitter.off('FOCUS_BOTTOM_TAB', onFocus); };
  }, [api, eventEmitter]);

  // Escape hatch: rebuild the default layout and forget the stored one.
  useEffect(() => {
    if (!api) return;
    const onReset = () => {
      // Every mode, not just this one: "Restore the default panel layout" reads as global, and it is also
      // the escape hatch when a stored arrangement is corrupt.
      clearLayouts();
      withProgrammaticLayout(() => {
        buildDefaultLayout(api);
        // buildDefaultLayout adds EVERY panel, and the mode has not changed, so the effect above will not
        // fire — reset has to re-apply the restriction itself or the current mode gets other modes' panels.
        assertRenderers(api);
        applyRestriction(api);
        restoreBottomTab(api);
        relayout(api);
      });
    };
    eventEmitter.on('RESET_DOCK_LAYOUT', onReset);
    return () => { eventEmitter.off('RESET_DOCK_LAYOUT', onReset); };
  }, [api, eventEmitter, applyRestriction, restoreBottomTab, withProgrammaticLayout]);

  return (
    <div className="flex-1 min-h-0 relative">
      <DockviewReact
        components={dockComponents}
        defaultTabComponent={PanelTab}
        theme={cleoTheme}
        onReady={onReady}
      />
    </div>
  );
}
