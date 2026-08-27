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

// Per-project. Both live keys resolve through lsScope, so deleting a project takes them with it.
const dockLayoutKey = () => lsKey(LS_KEYS.dockLayout);
// Pre-dockview layout blob ({ barsDimensions, bottomTab }); removed once on startup.
const OLD_LAYOUT_KEY = 'cleo_project_layout';
// Superseded layout keys, cleared on startup. Bump LAYOUT_VERSION whenever the panel set or the store's
// shape changes: a stored tree cannot gain a panel it has never heard of, and a stale panel id resolves
// to a component that no longer exists.
const OLD_DOCK_LAYOUT_KEYS = [
  'cleo_dock_layout_v1', 'cleo_dock_layout_v2', 'cleo_dock_layout_v3', 'cleo_dock_layout_v4',
  'cleo_dock_layout_v5', 'cleo_dock_layout_v6', 'cleo_dock_layout_v7', 'cleo_dock_layout_v8',
  'cleo_dock_layout_v9',
];
const LAYOUT_VERSION = 10;

/**
 * One saved arrangement per editor mode. There is deliberately no key for play: play is a restriction
 * applied on top of a mode, so nothing is saved while playing and Stop restores `layouts[mode]`.
 */
type LayoutStore = { version: typeof LAYOUT_VERSION; layouts: Partial<Record<EditorMode, SerializedDockview>> };

/**
 * Which of the stacked bottom panels the user last chose. Tracked outside the dockview layout blob so it
 * survives a restricted mode's discarded arrangement, the buildDefaultLayout fallback, and a reload.
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
 * Which bottom tab is currently selected, or null when the mode hides them both. Must read the group's
 * `activePanel`, not `panel.api.isVisible`: both bottom panels are `renderer: 'always'`, so visibility
 * does not track tab selection for them.
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

/** The two Add palettes, stacked as tabs above the Scene tree. Ordinary chrome, shown wherever the tree is. */
const ADD_PANELS = ['sceneAdd', 'uiAdd'] as const;

/** Renderer-mode panels: the performance readout and the render settings. Shown only there. */
const RENDERER_PANELS = ['performance', 'rendererSettings'] as const;

const CHROME_PANELS = [
  'scene', 'properties', 'scripts', 'physics', 'logger', 'assets',
  ...ANIMATION_PANELS, ...ANIMATION_FIELD_PANELS, ...TILEMAP_PANELS, ...ADD_PANELS,
] as const;

// The Scene panel hosts the mode-specific tree, so its tab label follows the mode.
const PANEL_TITLES: Record<string, string> = {
  viewport: 'Viewport', scene: 'Scene', sceneAdd: 'Scene Elements', uiAdd: 'UI Elements', properties: 'Properties',
  scripts: 'Scripts', physics: 'Physics', logger: 'Logger', assets: 'Assets',
  animClips: 'Clips', animVariables: 'Variables', animStateMachine: 'State Machine',
  animField: 'Blend Space',
  tilePalette: 'Tiles', tilemapLayers: 'Layers',
  performance: 'Performance', rendererSettings: 'Renderer Settings',
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

// The viewport is the immovable center anchor: no tab header and no dropping into it; edge drops beside
// it still work. Returns false when the panel is missing, which marks a restored layout as corrupt.
function assertViewportLock(api: DockviewApi): boolean {
  const vp = api.getPanel('viewport');
  if (!vp) return false;
  vp.group.locked = true;
  vp.group.header.hidden = true;
  return true;
}

// Scene/UI tabbed 20vw left, Properties/Scripts/Physics tabbed 25vw right, Logger/Assets in a 30vh strip
// under the viewport only. Every panel can be dragged out of its group and re-docked.
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
  // The palettes sit in their own group ABOVE the tree so the tree stays visible while either is in use.
  // The only place a non-viewport panel is split rather than tabbed.
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
  // The animation panels share the Properties tab strip; they are hidden everywhere but animation mode,
  // where Properties itself is hidden.
  for (const id of [...ANIMATION_PANELS, ...ANIMATION_FIELD_PANELS, ...TILEMAP_PANELS]) {
    api.addPanel({
      id, component: id, title: PANEL_TITLES[id],
      position: { referencePanel: 'properties', direction: 'within' },
    });
  }
  // Docked with Properties on the right rail. Neither is in CHROME_PANELS, so they survive into renderer
  // mode where the rest of that tab strip is hidden.
  for (const id of RENDERER_PANELS) {
    api.addPanel({
      id, component: id, title: PANEL_TITLES[id],
      position: { referencePanel: 'properties', direction: 'within' },
    });
  }
  scene.api.setActive();
  properties.api.setActive();
  // Logger and Assets need renderer:'always' so the hidden tab stays in the DOM: unmounting the asset
  // explorer tears down the SVAR store + drag patch and loses the folder being browsed.
  const logger = api.addPanel({
    id: 'logger', component: 'logger', title: 'Logger', renderer: 'always',
    position: { referencePanel: 'viewport', direction: 'below' },
    initialHeight: Math.round(height * 0.30),
  });
  const assets = api.addPanel({
    id: 'assets', component: 'assets', title: 'Assets', renderer: 'always',
    position: { referencePanel: 'logger', direction: 'within' },
  });
  // Honour the remembered bottom tab; this is also the fallback when restoring a stashed layout fails.
  (loadBottomTab() === 'assets' ? assets : logger).api.setActive();
  assertViewportLock(api);
}

/**
 * Re-assert `renderer: 'always'` on viewport/logger/assets; a restored blob is not guaranteed to carry it.
 * The default 'onlyWhenVisible' unmounts an unselected panel, tearing down the SVAR store and drag patch
 * for `assets` and the WebGL canvas host for `viewport`.
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
 * Force a layout pass after rebuilding the tree programmatically. `renderer: 'always'` panels are
 * positioned by a layout pass, not normal flow, so re-adding panels in the same tick leaves them stale.
 * Deferred a frame so the new groups have been measured first.
 */
function relayout(api: DockviewApi) {
  requestAnimationFrame(() => {
    const w = api.width || window.innerWidth;
    const h = api.height || window.innerHeight;
    try { api.layout(w, h, true); } catch { /* ignore */ }
  });
}

/**
 * Which panels a given mode / play state hides. A group is hidden once by default and a mode opts out, so
 * a new mode-specific group cannot leak into unrelated modes.
 */
function hiddenPanelIds(mode: EditorMode, playing: boolean): readonly string[] {
  // Renderer mode is the only branch that keeps the renderer panels.
  if (mode === 'renderer') return CHROME_PANELS;
  // Play strips the chrome AND both renderer panels.
  if (playing) return [...CHROME_PANELS, ...RENDERER_PANELS];

  const hidden = new Set<string>(RENDERER_PANELS);

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
    // Landscape and tilemap keep the tree and Properties: a terrain's size and heightmap live there.
    case 'landscape':
    case 'tilemap':
      hide('scripts', 'physics');
      break;
    // A model tab edits one thing, so there is no tree to browse: the model node stays selected (the
    // SELECT_NODE coercion in EngineContext) and Properties hosts both its inspector and its transform.
    case 'model':
      hide(...ADD_PANELS, 'scene', 'scripts', 'physics');
      break;
    // Animation brings its own three panels; the Scene panel becomes the skeleton tree (see panelTitle).
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
  // The controller's own memory of the last commit, not derived state: the effect needs the OUTGOING mode
  // to know which key to save the tree under before it swaps trees.
  const keyRef = useRef<EditorMode | null>(null);
  const playingRef = useRef(false);
  const bottomTabRef = useRef<BottomPanel>(loadBottomTab());
  // Non-zero while a layout pass we initiated is in flight. A rebuild emits a burst of layout events in
  // which the bottom group transiently reports the first tab, overwriting the remembered choice.
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
   * Put the remembered bottom tab back if a layout pass moved it. A no-op when it is already showing or
   * the mode hides it entirely: `setActive` also takes global focus.
   */
  const restoreBottomTab = useCallback((dock: DockviewApi) => {
    const want = bottomTabRef.current;
    const panel = dock.getPanel(want);
    if (panel && activeBottomTab(dock) !== want) panel.api.setActive();
  }, []);

  // Legacy cleanup only. The mode controller below owns every path that builds a tree and runs immediately
  // after this, because `editorMode` is already correct on the first render.
  const onReady = (event: DockviewReadyEvent) => {
    try { localStorage.removeItem(OLD_LAYOUT_KEY); } catch { /* ignore */ }
    for (const key of OLD_DOCK_LAYOUT_KEYS) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    }
    setApi(event.api);
  };

  // Persist the current mode's arrangement (debounced). Muted only while playing: play is a transient
  // restriction, not an arrangement worth remembering.
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
    // localStorage is synchronous, so this flush lands a drag that finished inside the debounce window.
    window.addEventListener('beforeunload', flush);
    return () => { clearTimeout(timer); disposable.dispose(); window.removeEventListener('beforeunload', flush); };
  }, [api]);

  /**
   * Retitle for the mode and close the panels it forbids. Every path that produces a full layout must run
   * this, including Reset Layout, which builds one while the mode is unchanged.
   */
  const applyRestriction = useCallback((dock: DockviewApi) => {
    for (const id of Object.keys(PANEL_TITLES)) dock.getPanel(id)?.api.setTitle(panelTitle(id, editorMode));
    for (const id of hiddenPanelIds(editorMode, isPlayMode)) dock.getPanel(id)?.api.close();
  }, [editorMode, isPlayMode]);

  // Mode/play controller. One path serves mode->mode, mode->play and play->mode: bank the outgoing mode's
  // arrangement, put the incoming mode's tree up, then restrict it. applyRestriction must run even on a
  // saved tree — it also expresses play and repairs a tree written by a build with a different panel set.
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
          // reuseExistingPanels keeps each panel's React subtree mounted across the swap; without it the
          // viewport re-parents the WebGL canvas on every mode switch.
          api.fromJSON(saved, { reuseExistingPanels: true });
          restored = assertViewportLock(api);
        } catch { restored = false; }
      }
      if (!restored) buildDefaultLayout(api);

      assertRenderers(api);
      applyRestriction(api);
      // fromJSON restores the tab selected when the tree was saved; put the user's choice back.
      restoreBottomTab(api);
      relayout(api); // opening/closing panels moves the always-rendered viewport and logger
    });
    keyRef.current = editorMode;
    playingRef.current = isPlayMode;
  }, [api, editorMode, isPlayMode, applyRestriction, restoreBottomTab, withProgrammaticLayout]);

  // Remember which bottom tab the user is on. When a mode hides both there is no selection to read, so
  // the remembered value is left alone.
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
      // A programmatic focus is still the tab the user ends up on, so it becomes the remembered one.
      const id: BottomPanel = tab === 'Logger' ? 'logger' : 'assets';
      bottomTabRef.current = id;
      try { localStorage.setItem(bottomTabKey(), id); } catch { /* ignore */ }
      api.getPanel(id)?.api.setActive();
    };
    eventEmitter.on('FOCUS_BOTTOM_TAB', onFocus);
    return () => { eventEmitter.off('FOCUS_BOTTOM_TAB', onFocus); };
  }, [api, eventEmitter]);

  useEffect(() => {
    if (!api) return;
    const onReset = () => {
      // Every mode, not just this one: reset is also the escape hatch for a corrupt stored arrangement.
      clearLayouts();
      withProgrammaticLayout(() => {
        buildDefaultLayout(api);
        // buildDefaultLayout adds EVERY panel and the mode has not changed, so the effect above will not
        // fire: reset must re-apply the restriction itself.
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
