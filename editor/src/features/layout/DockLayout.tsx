import { useEffect, useRef, useState } from 'react';
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

const DOCK_LAYOUT_KEY = 'cleo_dock_layout_v1';
// Pre-dockview layout blob ({ barsDimensions, bottomTab }); removed once on startup.
const OLD_LAYOUT_KEY = 'cleo_project_layout';
const CHROME_PANELS = ['explorer', 'inspector', 'logger', 'assets'] as const;

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

// Replicates the pre-dockview geometry: Explorer 20vw left, Inspector 25vw right, Logger/Assets
// stacked in a 30vh strip under the viewport only (between the sidebars, like the old BottomBar).
function buildDefaultLayout(api: DockviewApi) {
  api.clear();
  const width = api.width || window.innerWidth;
  const height = api.height || window.innerHeight;
  api.addPanel({ id: 'viewport', component: 'viewport', title: 'Viewport', renderer: 'always' });
  api.addPanel({
    id: 'explorer', component: 'explorer', title: 'Explorer',
    position: { referencePanel: 'viewport', direction: 'left' },
    initialWidth: Math.round(width * 0.20),
  });
  api.addPanel({
    id: 'inspector', component: 'inspector', title: 'Inspector',
    position: { referencePanel: 'viewport', direction: 'right' },
    initialWidth: Math.round(width * 0.25),
  });
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
    localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify({ version: 1, layout: api.toJSON() }));
  } catch { /* ignore */ }
}

// Which panels a mode/play-state hides (the old hideLeft/hideSides/hideBottom rules).
function hiddenPanelIds(mode: EditorMode, playing: boolean): readonly string[] {
  if (playing || mode === 'renderer') return CHROME_PANELS;
  if (mode === 'landscape') return ['explorer', 'inspector'];
  if (mode === 'material' || mode === 'terrainMaterial') return ['explorer'];
  return [];
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
    try {
      const raw = localStorage.getItem(DOCK_LAYOUT_KEY);
      if (!raw) throw new Error('no saved layout');
      const saved = JSON.parse(raw);
      if (saved?.version !== 1 || !saved.layout) throw new Error('unknown layout version');
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
    const hidden = hiddenPanelIds(editorMode, isPlayMode);
    restrictedRef.current = hidden.length > 0;
    if (hidden.length > 0) {
      fullLayoutRef.current = api.toJSON();
      // The stash IS the latest full layout — persist it now, since layout events are muted from
      // here until the restriction lifts.
      saveLayout(api);
      for (const id of hidden) api.getPanel(id)?.api.close();
    }
  }, [api, editorMode, isPlayMode]);

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
    };
    eventEmitter.on('RESET_DOCK_LAYOUT', onReset);
    return () => { eventEmitter.off('RESET_DOCK_LAYOUT', onReset); };
  }, [api, eventEmitter]);

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
