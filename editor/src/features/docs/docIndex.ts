import { DOC_FILES } from './docsSource';
import { parseDocs, pageIdFromPath, type DocIndex } from './parseDocs';

// The parsed docs, as a tiny external store: parsed on first use, re-parsed when a page changes under
// the dev server, and versioned so useSyncExternalStore re-renders every open tooltip after an edit.

let files: Record<string, string> = DOC_FILES;
let index: DocIndex | null = null;
let version = 0;
const listeners = new Set<() => void>();

function byPageId(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, md] of Object.entries(raw)) out[pageIdFromPath(path)] = md;
  return out;
}

export function getDocIndex(): DocIndex {
  return (index ??= parseDocs(byPageId(files)));
}

export function getDocsVersion(): number {
  return version;
}

export function subscribeDocs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (import.meta.hot) {
  import.meta.hot.accept('./docsSource', (mod) => {
    if (!mod) return;
    files = (mod as unknown as { DOC_FILES: Record<string, string> }).DOC_FILES;
    index = null;
    version++;
    for (const l of listeners) l();
  });
}

// ---------------------------------------------------------------------------------------------------
// Dev diagnostics: which titles found no entry, and which inline field hints the docs now override.
// `window.cleoDocs.misses()` after clicking through a mode is the to-do list for the docs.

const misses = new Map<string, { title: string; scope: string }>();
const shadowed = new Map<string, { label: string; hint: string; entry: string }>();

export function reportMiss(title: string, scope: string): void {
  if (!import.meta.env.DEV) return;
  const key = `${scope}|${title}`;
  if (misses.has(key)) return;
  misses.set(key, { title, scope });
  console.warn(`[docs] no entry for "${title}" in ${scope || '(no scope)'}`);
}

export function reportShadowedHint(label: string, hint: string, entry: string): void {
  if (!import.meta.env.DEV) return;
  shadowed.set(`${entry}|${label}`, { label, hint, entry });
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { cleoDocs: unknown }).cleoDocs = {
    misses: () => [...misses.values()],
    shadowedHints: () => [...shadowed.values()],
    index: getDocIndex,
  };
}
