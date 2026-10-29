import { useCallback, useEffect, useRef, type FunctionComponent } from 'react';
import {
  DockviewApi,
  DockviewReact,
  DockviewReadyEvent,
  DockviewTheme,
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
  SerializedDockview,
} from 'dockview-react';
import '../styles/dockview.css';

/** The dockview skin every Cleo application uses (see styles/dockview.css). */
export const cleoDockTheme: DockviewTheme = { name: 'cleo', className: 'dockview-theme-cleo', colorScheme: 'dark' };

/**
 * Make panel `id` the immovable centre anchor: no tab header and no dropping into it; edge drops beside
 * it still work. Returns false when the panel is missing, which marks a restored layout as corrupt.
 */
export function lockAnchorPanel(api: DockviewApi, id = 'viewport'): boolean {
  const panel = api.getPanel(id);
  if (!panel) return false;
  panel.group.locked = true;
  panel.group.header.hidden = true;
  return true;
}

type StoredLayout = { version: number; layout: SerializedDockview };

/** The saved arrangement under `key`, or null when absent, unreadable or from another `version`. */
export function loadDockLayout(key: string, version: number): SerializedDockview | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredLayout;
    return parsed?.version === version ? parsed.layout : null;
  } catch { return null; }
}

export function saveDockLayout(key: string, version: number, layout: SerializedDockview): void {
  try { localStorage.setItem(key, JSON.stringify({ version, layout } satisfies StoredLayout)); } catch { /* quota */ }
}

export interface DockShellProps {
  /** Panel component registry, by the ids `buildDefault` and saved layouts use. */
  components: Record<string, FunctionComponent<IDockviewPanelProps>>;
  /** Optional tab renderer shared by every panel. */
  tabComponent?: FunctionComponent<IDockviewPanelHeaderProps>;
  /** localStorage key the arrangement persists under. */
  storageKey: string;
  /**
   * Bump whenever the panel set changes: a stored tree cannot gain a panel it has never heard of, and a
   * stale id resolves to a component that no longer exists, so a mismatched store is discarded.
   */
  version: number;
  /** Lay the panels out from nothing; also the fallback when a stored layout fails to restore. */
  buildDefault: (api: DockviewApi) => void;
  /** Panel kept as the locked centre (see lockAnchorPanel); null for none. */
  anchorPanel?: string | null;
  onReady?: (api: DockviewApi) => void;
}

/**
 * A dockview workspace with the Cleo skin and a versioned, persisted arrangement: restore the saved
 * layout if it is current and complete, otherwise build the default, and save on every change.
 */
export function DockShell({ components, tabComponent, storageKey, version, buildDefault, anchorPanel = 'viewport', onReady }: DockShellProps) {
  const apiRef = useRef<DockviewApi | null>(null);

  const handleReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    const stored = loadDockLayout(storageKey, version);
    let restored = false;
    if (stored) {
      try {
        api.fromJSON(stored);
        restored = anchorPanel ? lockAnchorPanel(api, anchorPanel) : true;
      } catch { restored = false; }
    }
    if (!restored) {
      api.clear();
      buildDefault(api);
      if (anchorPanel) lockAnchorPanel(api, anchorPanel);
    }
    onReady?.(api);
  }, [storageKey, version, buildDefault, anchorPanel, onReady]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const sub = api.onDidLayoutChange(() => saveDockLayout(storageKey, version, api.toJSON()));
    return () => sub.dispose();
  });

  return (
    <DockviewReact
      components={components}
      defaultTabComponent={tabComponent}
      theme={cleoDockTheme}
      onReady={handleReady}
    />
  );
}
