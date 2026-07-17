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
import './dockview.css';

const DOCK_LAYOUT_KEY = 'cleo_dock_layout_v3';
// Pre-dockview layout blob ({ barsDimensions, bottomTab }); removed once on startup.
const OLD_LAYOUT_KEY = 'cleo_project_layout';
// v1 grouped Scene/UI under one "explorer" panel and Properties/Scripts/Physics under one
// "inspector" panel; v2 promoted all five to panels of their own. v3 adds the three animation panels —
// a restored v2 blob simply has no record of them, so those panels would never exist. Every version bump
// here discards saved arrangements on purpose: a stale layout cannot gain a panel it has never heard of.
const OLD_DOCK_LAYOUT_KEY = 'cleo_dock_layout_v1';
const OLD_DOCK_LAYOUT_KEY_V2 = 'cleo_dock_layout_v2';
const LAYOUT_VERSION = 3;

/** Animation-editor panels. Present in every layout, shown only in animation mode — see hiddenPanelIds. */
const ANIMATION_PANELS = ['animClips', 'animVariables', 'animStateMachine'] as const;

const CHROME_PANELS = [
  'scene', 'ui', 'properties', 'scripts', 'physics', 'logger', 'assets', ...ANIMATION_PANELS,
] as const;

// The Scene panel hosts the mode-specific tree (there is no separate dock panel for it), so its tab label
// follows the mode. The animation editor's own panels are real panels with fixed titles.
const PANEL_TITLES: Record<string, string> = {
  viewport: 'Viewport', scene: 'Scene', ui: 'UI', properties: 'Properties',
  scripts: 'Scripts', physics: 'Physics', logger: 'Logger', assets: 'Assets',
  animClips: 'Clips', animVariables: 'Variables', animStateMachine: 'State Machine',
};

function panelTitle(id: string, mode: EditorMode): string {
  if (id === 'scene' && mode === 'animation') return 'Skeleton';
  if (id === 'properties') {
    if (mode === 'material') return 'Material';
    if (mode === 'terrainMaterial') return 'Terrain Material';
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
  api.addPanel({
    id: 'ui', component: 'ui', title: 'UI',
    position: { referencePanel: 'scene', direction: 'within' },
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
  for (const id of ANIMATION_PANELS) {
    api.addPanel({
      id, component: id, title: PANEL_TITLES[id],
      position: { referencePanel: 'properties', direction: 'within' },
    });
  }
  scene.api.setActive();
  properties.api.setActive();
  // Logger and Assets keep renderer:'always' so the hidden tab stays in the DOM: unmounting the
  // asset explorer would tear down the SVAR store + drag patch and lose the folder being browsed.
  const logger = api.addPanel({
    id: 'logger', component: 'logger', title: 'Logger', renderer: 'always',
    position: { referencePanel: 'viewport', direction: 'below' },
    initialHeight: Math.round(height * 0.30),
  });
  api.addPanel({
    id: 'assets', component: 'assets', title: 'Assets', renderer: 'always',
    position: { referencePanel: 'logger', direction: 'within' },
  });
  logger.api.setActive();
  assertViewportLock(api);
}

function saveLayout(api: DockviewApi) {
  try {
    localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify({ version: LAYOUT_VERSION, layout: api.toJSON() }));
  } catch { /* ignore */ }
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

// Which panels a mode/play-state hides. Modes that take a host panel over (Properties shows the state
// machine / material editors, Scene shows the skeleton tree) hide the panels that no longer apply.
function hiddenPanelIds(mode: EditorMode, playing: boolean): readonly string[] {
  if (playing || mode === 'renderer') return CHROME_PANELS;

  // The animation panels are the inverse of every other panel: hidden by default, shown in one mode. They
  // are prepended to every branch below rather than added to each list, because the fallthrough is
  // `return []` ("show everything") — miss one branch and Clips leaks into scene mode.
  const anim: readonly string[] = mode === 'animation' ? [] : ANIMATION_PANELS;

  if (mode === 'landscape') return [...anim, 'scene', 'ui', 'properties', 'scripts', 'physics'];
  if (mode === 'material' || mode === 'terrainMaterial') return [...anim, 'scene', 'ui', 'scripts', 'physics'];
  // Animation brings its own three panels, so Properties has nothing left to host.
  if (mode === 'animation') return ['ui', 'scripts', 'physics', 'properties'];
  if (mode === 'template') return [...anim, 'ui']; // the UI layer is irrelevant while authoring a template
  // A mesh tab is a read-only preview: keep Scene + Properties to inspect the subtree, drop the rest.
  if (mode === 'mesh') return [...anim, 'ui', 'scripts', 'physics'];
  // A script tab is a pure code editor (rendered over the viewport): drop every node/scene chrome panel.
  if (mode === 'script') return [...anim, 'scene', 'ui', 'properties', 'scripts', 'physics'];
  return anim;
}

export default function DockLayout() {
  const { eventEmitter, editorMode, isPlayMode } = useCleoEngine();
  const [api, setApi] = useState<DockviewApi | null>(null);
  // While a mode/play restriction hides panels, the full layout is stashed here and restored when
  // the restriction lifts; restricted layouts are never persisted (rearrangements made in a
  // restricted mode are deliberately discarded, matching the old collapse-and-restore behavior).
  const fullLayoutRef = useRef<SerializedDockview | null>(null);
  const restrictedRef = useRef(false);

  const onReady = (event: DockviewReadyEvent) => {
    const dock = event.api;
    try { localStorage.removeItem(OLD_LAYOUT_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(OLD_DOCK_LAYOUT_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(OLD_DOCK_LAYOUT_KEY_V2); } catch { /* ignore */ }
    try {
      const raw = localStorage.getItem(DOCK_LAYOUT_KEY);
      if (!raw) throw new Error('no saved layout');
      const saved = JSON.parse(raw);
      if (saved?.version !== LAYOUT_VERSION || !saved.layout) throw new Error('unknown layout version');
      dock.fromJSON(saved.layout);
      if (!assertViewportLock(dock)) throw new Error('layout missing viewport');
    } catch {
      try { localStorage.removeItem(DOCK_LAYOUT_KEY); } catch { /* ignore */ }
      buildDefaultLayout(dock);
    }
    setApi(dock);
  };

  // Persist the layout (debounced); skipped while a restriction is applied.
  useEffect(() => {
    if (!api) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disposable = api.onDidLayoutChange(() => {
      if (restrictedRef.current) return;
      clearTimeout(timer);
      timer = setTimeout(() => saveLayout(api), 300);
    });
    return () => { clearTimeout(timer); disposable.dispose(); };
  }, [api]);

  /**
   * Retitle for the mode and close the panels it forbids. Every path that produces a full layout has to run
   * this — the mode effect below AND Reset Layout, which builds one from scratch while the mode is unchanged
   * and so cannot rely on that effect firing.
   */
  const applyRestriction = useCallback((dock: DockviewApi) => {
    for (const id of Object.keys(PANEL_TITLES)) dock.getPanel(id)?.api.setTitle(panelTitle(id, editorMode));
    const hidden = hiddenPanelIds(editorMode, isPlayMode);
    restrictedRef.current = hidden.length > 0;
    if (hidden.length > 0) {
      fullLayoutRef.current = dock.toJSON();
      // The stash IS the latest full layout — persist it now, since layout events are muted from
      // here until the restriction lifts.
      saveLayout(dock);
      for (const id of hidden) dock.getPanel(id)?.api.close();
    }
  }, [editorMode, isPlayMode]);

  // Mode/play restriction controller: restore the stashed full layout first (no-op when
  // unrestricted), then hide the panels the new mode forbids.
  useEffect(() => {
    if (!api) return;
    if (fullLayoutRef.current) {
      const stash = fullLayoutRef.current;
      fullLayoutRef.current = null;
      try {
        api.fromJSON(stash, { reuseExistingPanels: true });
        if (!assertViewportLock(api)) throw new Error('stash missing viewport');
      } catch {
        buildDefaultLayout(api);
      }
    }
    applyRestriction(api);
    relayout(api); // opening/closing panels moves the always-rendered viewport and logger
  }, [api, editorMode, isPlayMode, applyRestriction]);

  // The in-viewport UI overlay only draws while the user is editing UI. Now that Scene and UI are
  // separate panels, "the UI tab is active" becomes "the UI panel is visible" — which also covers the
  // user splitting Scene and UI side by side (both visible: the overlay correctly stays on).
  useEffect(() => {
    if (!api) return;
    let last: 'Scene' | 'UI' | null = null;
    const sync = () => {
      const tab = api.getPanel('ui')?.api.isVisible ? 'UI' : 'Scene';
      if (tab === last) return;
      last = tab;
      eventEmitter.emit('EXPLORER_TAB', tab);
      eventEmitter.emit(tab === 'UI' ? 'UI_CHANGED' : 'SCENE_CHANGED');
    };
    sync();
    const disposables = [api.onDidLayoutChange(sync), api.onDidActivePanelChange(sync)];
    return () => { disposables.forEach(d => d.dispose()); };
  }, [api, eventEmitter]);

  // "New asset" flows focus the Assets tab (legacy per-kind tab names all meant Assets).
  useEffect(() => {
    if (!api) return;
    const onFocus = (tab: unknown) => {
      api.getPanel(tab === 'Logger' ? 'logger' : 'assets')?.api.setActive();
    };
    eventEmitter.on('FOCUS_BOTTOM_TAB', onFocus);
    return () => { eventEmitter.off('FOCUS_BOTTOM_TAB', onFocus); };
  }, [api, eventEmitter]);

  // Escape hatch: rebuild the default layout and forget the stored one.
  useEffect(() => {
    if (!api) return;
    const onReset = () => {
      try { localStorage.removeItem(DOCK_LAYOUT_KEY); } catch { /* ignore */ }
      fullLayoutRef.current = null;
      restrictedRef.current = false;
      buildDefaultLayout(api);
      // buildDefaultLayout adds EVERY panel, and the mode has not changed, so the effect above will not
      // fire — reset has to re-apply the restriction itself or the current mode gets other modes' panels.
      applyRestriction(api);
      relayout(api);
    };
    eventEmitter.on('RESET_DOCK_LAYOUT', onReset);
    return () => { eventEmitter.off('RESET_DOCK_LAYOUT', onReset); };
  }, [api, eventEmitter, applyRestriction]);

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
