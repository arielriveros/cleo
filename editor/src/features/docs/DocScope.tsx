import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { getDocIndex, getDocsVersion, reportMiss, subscribeDocs } from './docIndex';
import { frameOf, resolveDocKey, resolveTerm, type DocEntry, type DocFrame } from './parseDocs';

// Where in the docs a piece of editor UI is described. A panel or an editor declares its page with
// <DocScope>; every Collapsable / Section then narrows the scope to its own entry for what sits inside
// it, so a nested "Options" resolves under the material editor and a "Resolution" row under Shadows.

const DocFramesContext = createContext<DocFrame[]>([]);

export interface DocScopeProps {
  /** Page id under docs/ without `.md`, e.g. `editor/physics`. */
  page: string;
  /** Anchor of a heading on that page, to look there first (and let field labels match its rows). */
  section?: string;
  children: ReactNode;
}

/** Declare the docs page that describes everything inside; nested scopes fall back outwards. */
export function DocScope({ page, section, children }: DocScopeProps) {
  const parent = useContext(DocFramesContext);
  const frames = useMemo<DocFrame[]>(() => [{ page, section, fields: section !== undefined }, ...parent], [page, section, parent]);
  return <DocFramesContext.Provider value={frames}>{children}</DocFramesContext.Provider>;
}

/** Narrow the scope to a resolved entry's section. Always renders the provider, so the tree is stable. */
export function DocRegion({ entry, children }: { entry: DocEntry | null; children: ReactNode }) {
  const parent = useContext(DocFramesContext);
  const frames = useMemo(() => {
    const frame = entry && frameOf(getDocIndex(), entry);
    return frame ? [frame, ...parent] : parent;
  }, [entry, parent]);
  return <DocFramesContext.Provider value={frames}>{children}</DocFramesContext.Provider>;
}

/** The scope chain as text, for the miss log. */
function describe(frames: DocFrame[]): string {
  return frames.map(f => (f.section ? `${f.page}#${f.section}` : f.page)).join(' > ');
}

/**
 * The docs entry for a title or a field label, re-resolved whenever the docs change.
 *
 * `doc` overrides the lookup: a term, `page#anchor`, or `page[#anchor]::Term` (see resolveDocKey), and
 * `false` opts out. Without it, a string `text` is looked up through the scope chain. A title that finds
 * nothing is logged in dev; a field that finds nothing just keeps its inline hint.
 */
export function useDocEntry(text: ReactNode, doc?: string | false, mode: 'title' | 'field' = 'title'): DocEntry | null {
  const frames = useContext(DocFramesContext);
  const version = useSyncExternalStore(subscribeDocs, getDocsVersion);
  return useMemo(() => {
    if (doc === false) return null;
    const query = doc ?? (typeof text === 'string' ? text : undefined);
    if (query === undefined || !query.trim()) return null;
    const index = getDocIndex();
    const entry = doc !== undefined ? resolveDocKey(index, frames, doc, mode) : resolveTerm(index, frames, query, mode);
    if (!entry && mode === 'title') reportMiss(query, describe(frames));
    return entry;
    // `version` is the docs' revision: a new one means the same lookup may now find something else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, doc, mode, frames, version]);
}
