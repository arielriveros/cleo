import { parseDocs, pageIdFromPath, resolveDocLink, type DocIndex } from './parseDocs';

// The parsed docs, as a tiny external store: parsed on first use, re-parsed when a page changes under
// the dev server, and versioned so useSyncExternalStore re-renders every open tooltip after an edit.
//
// The markdown itself comes from the application: `import.meta.glob` takes only a literal pattern, so
// each app globs its own docs (the editor all of docs/, Cleo Creator docs/creator/) in a module of its
// own and hands the result to registerDocSources. That module re-registers on HMR, which is what makes
// an edited page show up in the open tooltips without a reload.

let files: Record<string, string> = {};
let sources: Record<string, string> | null = null;
let index: DocIndex | null = null;
let order: string[] | null = null;
let version = 0;
const listeners = new Set<() => void>();

function byPageId(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, md] of Object.entries(raw)) out[pageIdFromPath(path)] = md;
  return out;
}

function getSources(): Record<string, string> {
  return (sources ??= byPageId(files));
}

export function getDocIndex(): DocIndex {
  return (index ??= parseDocs(getSources()));
}

/** A page's markdown, as bundled (`editor/rendering`), or undefined when the app does not carry it. */
export function getDocSource(pageId: string): string | undefined {
  return getSources()[pageId];
}

/**
 * Every bundled page id in reading order: the order docs/README.md (the table of contents) first links
 * to them, then any page it never links, alphabetically. The docs viewer's sidebar follows it, so
 * reordering the README reorders the sidebar.
 */
export function pageOrder(): string[] {
  if (order) return order;
  const all = getSources();
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (id: string) => { if (id in all && !seen.has(id)) { seen.add(id); out.push(id); } };
  const readme = all.README;
  if (readme !== undefined) {
    push('README');
    for (const m of readme.matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = resolveDocLink('README', m[1]);
      if (link.kind === 'page') push(link.page);
    }
  }
  for (const id of Object.keys(all).sort()) push(id);
  return (order = out);
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
  sources = null;
  index = null;
  order = null;
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
