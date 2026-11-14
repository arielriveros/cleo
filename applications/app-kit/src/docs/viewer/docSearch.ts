import { breadcrumb, normalizeKey, plainText, type DocIndex } from '../parseDocs';
import type { DocTarget } from './docsViewerStore';

// The docs viewer's search: over the parsed index, so it finds what the tooltips find -- page titles,
// headings and every entry (table rows, `**Term** —` definitions) -- and then plain body text. No
// separate search index: the DocIndex is already in memory and small (a few thousand entries).

export interface DocSearchHit {
  target: DocTarget;
  /** The page title, heading or term that matched. */
  label: string;
  /** Where it sits: "Rendering › Shadows". */
  crumb: string;
  /** A slice of the body around the match, plain text; empty for a title hit. */
  snippet: string;
  score: number;
}

const MAX_HITS = 30;
const SNIPPET = 90;

function snippetAround(text: string, at: number): string {
  if (at < 0) return text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text;
  const start = Math.max(0, at - 30);
  const out = text.slice(start, start + SNIPPET);
  return `${start > 0 ? '…' : ''}${out}${start + SNIPPET < text.length ? '…' : ''}`;
}

/** How well a label answers the query: whole, prefix, word prefix, contains -- or 0. */
function labelScore(label: string, q: string): number {
  const key = normalizeKey(label);
  if (!key) return 0;
  if (key === q) return 100;
  if (key.startsWith(q)) return 80;
  if (key.includes(` ${q}`)) return 65;
  if (key.includes(q)) return 50;
  return 0;
}

/** The best matches for `query`, strongest first; page titles outrank headings outrank entries. */
export function searchDocs(index: DocIndex, query: string): DocSearchHit[] {
  const q = normalizeKey(query);
  if (q.length < 2) return [];
  const hits: DocSearchHit[] = [];
  const seen = new Set<string>();
  const add = (hit: DocSearchHit) => {
    const key = `${hit.target.page}:${hit.target.line ?? 0}:${hit.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  };

  for (const page of index.pages.values()) {
    const titleScore = labelScore(page.title, q);
    if (titleScore) add({ target: { page: page.id }, label: page.title, crumb: page.id, snippet: '', score: titleScore + 30 });

    for (const h of page.headings) {
      const s = labelScore(h.text, q);
      if (!s) continue;
      const trail: string[] = [];
      for (let p = h.parent; p >= 0; p = page.headings[p].parent) trail.unshift(page.headings[p].text);
      add({ target: { page: page.id, line: h.line }, label: h.text, crumb: [page.title, ...trail].join(' › '), snippet: '', score: s + 15 });
    }

    for (const e of page.entries) {
      if (e.kind === 'heading') continue;
      const s = labelScore(e.label, q);
      const body = plainText(e.body);
      if (s) {
        add({ target: { page: page.id, line: e.line }, label: e.label, crumb: breadcrumb(index, e), snippet: snippetAround(body, -1), score: s });
        continue;
      }
      const at = body.toLowerCase().indexOf(query.trim().toLowerCase());
      if (at >= 0) add({ target: { page: page.id, line: e.line }, label: e.label, crumb: breadcrumb(index, e), snippet: snippetAround(body, at), score: 10 });
    }

    // Heading bodies (a section's first paragraph) as text matches, under the heading's name.
    for (const e of page.entries) {
      if (e.kind !== 'heading') continue;
      const body = plainText(e.body);
      const at = body.toLowerCase().indexOf(query.trim().toLowerCase());
      if (at >= 0) add({ target: { page: page.id, line: e.line }, label: e.label, crumb: breadcrumb(index, e), snippet: snippetAround(body, at), score: 8 });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
  return hits.slice(0, MAX_HITS);
}
