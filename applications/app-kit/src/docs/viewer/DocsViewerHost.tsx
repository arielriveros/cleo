import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getActiveCardEntry, isInspecting, resolveElementDoc } from '../docTargets';
import { DOCS_WINDOW_ATTR, startWhatsThis, WhatsThisOverlay } from '../whatsThis';
import { getDocsViewerState, openDocs, setDocsHome, subscribeDocsViewer } from './docsViewerStore';
import { DocsWindow } from './DocsWindow';

// The docs viewer's one mount point per app, beside its other global surfaces (DialogHost, ToastStack):
// the window while it is open, the What's This? overlay, and the two keys --
//   F1        the docs for what is under the pointer: the hover card's entry when one shows, else the
//             element's own entry, section or panel page (as What's This? would resolve it);
//   Shift+F1  What's This?.

export interface DocsViewerHostProps {
  /** The page Help > Documentation starts on: `README` in the editor, `creator/index` in Creator. */
  home: string;
  /** localStorage key for the window's position, size and sidebar. */
  storageKey?: string;
  /** False while the app's keys belong to something else (a game in Play owns the keyboard). */
  keysEnabled?: () => boolean;
}

/** Help > Documentation. */
export function openDocumentation(): void {
  openDocs();
}

export function DocsViewerHost({ home, storageKey = 'cleo_docs_window', keysEnabled }: DocsViewerHostProps) {
  const state = useSyncExternalStore(subscribeDocsViewer, getDocsViewerState);
  const enabled = useRef(keysEnabled);
  enabled.current = keysEnabled;

  useEffect(() => { setDocsHome(home); }, [home]);

  useEffect(() => {
    let last: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => { last = { x: e.clientX, y: e.clientY }; };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F1' || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      if (enabled.current && !enabled.current()) return;
      // Also keeps the browser from opening its own help page.
      e.preventDefault();
      if (e.shiftKey) { startWhatsThis(); return; }
      if (isInspecting()) return;
      const card = getActiveCardEntry();
      if (card) { openDocs({ page: card.page, line: card.line }); return; }
      const el = last && document.elementFromPoint(last.x, last.y);
      if (el && !el.closest(`[${DOCS_WINDOW_ATTR}]`)) {
        const doc = resolveElementDoc(el, home);
        if (doc.source !== 'home') { openDocs(doc.target); return; }
      }
      openDocs();
    };
    window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('keydown', onKey, true);
    };
  }, [home]);

  return (
    <>
      {state.open && <DocsWindow storageKey={storageKey} />}
      <WhatsThisOverlay home={home} />
    </>
  );
}

if (import.meta.env?.DEV && typeof window !== 'undefined') {
  // `cleoDocs.open('editor/rendering#shadows')` from the console, beside docIndex's misses() helper.
  const w = window as unknown as { cleoDocs?: Record<string, unknown> };
  w.cleoDocs = {
    ...(w.cleoDocs ?? {}),
    open: (where: string) => {
      const [page, anchor] = where.split('#');
      openDocs({ page, anchor: anchor || undefined });
    },
    whatsThis: startWhatsThis,
  };
}
