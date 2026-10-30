import { parseDocs, pageIdFromPath, type DocIndex } from './parseDocs';

// The parsed docs, as a tiny external store: parsed on first use, re-parsed when a page changes under
// the dev server, and versioned so useSyncExternalStore re-renders every open tooltip after an edit.
//
// The markdown itself comes from the application: `import.meta.glob` takes only a literal pattern, so
// each app globs its own docs (the editor all of docs/, Cleo Creator docs/creator/) in a module of its
// own and hands the result to registerDocSources. That module re-registers on HMR, which is what makes
// an edited page show up in the open tooltips without a reload.

let files: Record<string, string> = {};
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

/**
 * Install the raw markdown, keyed by path (anything ending `docs/<page>.md`). Replaces what was there and
 * re-renders every subscribed tooltip.
 */
export function registerDocSources(raw: Record<string, string>): void {
  files = raw;
  index = null;
  version++;
  for (const l of listeners) l();
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
