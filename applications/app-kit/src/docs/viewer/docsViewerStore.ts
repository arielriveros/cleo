// The docs viewer's state, as a tiny external store (like docIndex and the Creator's menuStore): whether
// the window is open, the page it shows, and the back / forward history. Anything may open it --
// Help > Documentation, F1 on a hover card, a What's This? click, a link inside a page -- without a
// context or a prop path to the host, which every app mounts once beside its other global surfaces.

/** A place in the docs: a page id (`editor/rendering`), optionally a source line or a heading anchor. */
export interface DocTarget {
  page: string;
  /** 1-based source line of the entry to scroll to (a DocEntry's `line`). */
  line?: number;
  /** A heading anchor (`#shadows`), as a link writes it. */
  anchor?: string;
}

interface HistoryItem extends DocTarget {
  /** Where the reading column was scrolled when the reader left this place; going back restores it. */
  scroll?: number;
}

export interface DocsViewerState {
  open: boolean;
  current: HistoryItem | null;
  back: HistoryItem[];
  forward: HistoryItem[];
  /** Bumped on every navigation, so the view re-scrolls even when the target is the same place again. */
  nav: number;
}

const HISTORY_LIMIT = 100;

let state: DocsViewerState = { open: false, current: null, back: [], forward: [], nav: 0 };
let home = 'README';
const listeners = new Set<() => void>();

function set(next: Partial<DocsViewerState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function subscribeDocsViewer(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getDocsViewerState(): DocsViewerState {
  return state;
}

/** The page Help > Documentation opens on before anything else was read (the app's own index page). */
export function setDocsHome(page: string): void {
  home = page;
}

export function getDocsHome(): string {
  return home;
}

const same = (a: DocTarget | null, b: DocTarget) =>
  !!a && a.page === b.page && a.line === b.line && a.anchor === b.anchor;

/**
 * Show `target` (pushing the current place onto the back stack), or with no target just open the window
 * where it was last left -- on the home page the first time.
 */
export function openDocs(target?: DocTarget): void {
  if (!target) {
    set({ open: true, current: state.current ?? { page: home }, nav: state.nav + 1 });
    return;
  }
  if (same(state.current, target)) {
    // Asked for the place it already shows: scroll back to the target, not to where the reader wandered.
    if (state.current) state.current.scroll = undefined;
    set({ open: true, nav: state.nav + 1 });
    return;
  }
  const back = state.current ? [...state.back, state.current].slice(-HISTORY_LIMIT) : state.back;
  set({ open: true, current: { ...target }, back, forward: [], nav: state.nav + 1 });
}

export function closeDocs(): void {
  if (state.open) set({ open: false });
}

export function goBack(): void {
  const prev = state.back[state.back.length - 1];
  if (!prev) return;
  set({
    current: prev,
    back: state.back.slice(0, -1),
    forward: state.current ? [state.current, ...state.forward] : state.forward,
    nav: state.nav + 1,
  });
}

export function goForward(): void {
  const next = state.forward[0];
  if (!next) return;
  set({
    current: next,
    back: state.current ? [...state.back, state.current] : state.back,
    forward: state.forward.slice(1),
    nav: state.nav + 1,
  });
}

/**
 * Remember the reading column's scroll for the current place. Mutates without notifying: it is only read
 * back when the reader returns here, and re-rendering the page on every scroll event would be waste.
 */
export function noteDocsScroll(top: number): void {
  if (state.current) state.current.scroll = top;
}
