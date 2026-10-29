// The official docs (Engine/docs/**/*.md) parsed into an index of UI terms, so the editor's tooltips
// are READ from the docs instead of being written a second time beside each title. Pure: no Vite, no
// DOM, so the coverage test runs it on plain fs reads.
//
// What counts as an entry, strongest first (see "Docs feed the editor's tooltips" in docs/README.md):
//   - a heading: its first prose paragraph;
//   - a table row whose first cell is bold: the last column, the other columns as `meta`;
//   - `**Term** — description`, in a paragraph, a `- ` bullet or a `1. ` item;
//   - `**Label:** text` / `**Label.** text`;
//   - a paragraph that merely opens with a bold term (the whole paragraph).
// Fenced code, blockquote notes and the "See also" footer are skipped.

export type DocEntryKind = 'heading' | 'row' | 'term' | 'lead' | 'mention';

export interface DocHeading {
  /** 1-6 for `#` headings; a bold-only line is a pseudo-heading one level under the heading above it. */
  level: number;
  /** Plain text, markup and the `*(unreleased)*` marker removed. */
  text: string;
  /** GitHub-style slug, the same one a link `page.md#anchor` uses. */
  anchor: string;
  pseudo: boolean;
  /** Index of the enclosing heading in `DocPage.headings`, -1 for the page title. */
  parent: number;
}

export interface DocMeta { label: string; value: string }

export interface DocEntry {
  page: string;
  kind: DocEntryKind;
  /** What the card shows as its title: the bold cell / bold group / heading, as plain text. */
  label: string;
  /** Normalized lookup keys, one per term (a compound `**A** / **B**` yields A, B and "A / B"). */
  keys: string[];
  /** The same keys with a trailing parenthetical dropped, for the second, looser match. */
  looseKeys: string[];
  /**
   * The parts of a compound term ("Softness / Strength" -> softness, strength), matched only when no
   * whole term does: a label that merely contains a slash ("Max substeps / frame") must not answer for
   * a title "Frame" ahead of the entry that is really called that.
   */
  partKeys: string[];
  /** Inline markdown. */
  body: string;
  meta: DocMeta[];
  /** The heading this entry lives under; for a heading entry, that heading itself. */
  heading: number;
}

export interface DocPage {
  id: string;
  title: string;
  headings: DocHeading[];
  entries: DocEntry[];
}

export interface DocIndex {
  pages: Map<string, DocPage>;
}

// ---------------------------------------------------------------------------------------------------
// Text helpers

const UNRELEASED = /\*?\(unreleased[^)]*\)\*?/gi;

/** Inline markdown -> plain text (links keep their text, emphasis and code spans their content). */
export function plainText(md: string): string {
  return md
    .replace(/\\\|/g, '|')
    .replace(UNRELEASED, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** GitHub's heading slug: lowercase, punctuation dropped, every space a hyphen (not collapsed). */
export function slugify(headingMarkdown: string): string {
  const rendered = headingMarkdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .trim()
    .toLowerCase();
  return rendered.replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/**
 * The lookup form of a title or a term: case, markup, punctuation and `(unreleased)` ignored, `&` / `/` /
 * `+` read as "and" (so "Tone / Post" finds "Tone and post"), and a trailing count dropped ("Slots (3)").
 */
export function normalizeKey(text: string): string {
  return plainText(text)
    .toLowerCase()
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/\s*[&/+]\s*/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `normalizeKey` with any trailing parenthetical removed first: "Passes (CPU / GPU)" -> "passes". */
export function looseKey(text: string): string {
  return normalizeKey(plainText(text).replace(/\s*\([^)]*\)\s*$/, ''));
}

/** The bold spans of a fragment, and the parts of any compound span ("A / B"). */
function boldTerms(fragment: string): { terms: string[]; parts: string[] } {
  const terms: string[] = [];
  const parts: string[] = [];
  for (const m of fragment.matchAll(/\*\*([^*]+)\*\*/g)) {
    const term = plainText(m[1]).replace(/[:.]$/, '').trim();
    if (!term) continue;
    terms.push(term);
    if (term.includes('/')) for (const part of term.split('/')) if (part.trim()) parts.push(part.trim());
  }
  return { terms, parts };
}

function keysOf(terms: string[], parts: string[]): { keys: string[]; looseKeys: string[]; partKeys: string[] } {
  const keys = [...new Set(terms.map(normalizeKey).filter(Boolean))];
  const looseKeys = [...new Set(terms.map(looseKey).filter(Boolean))];
  const partKeys = [...new Set(parts.map(normalizeKey).filter(k => k && !keys.includes(k)))];
  return { keys, looseKeys, partKeys };
}

/** Split a table row on unescaped pipes, dropping the outer empty cells. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') { cell += '\\|'; i++; continue; }
    if (c === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += c;
  }
  cells.push(cell.trim());
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

// A run of bold terms joined by commas, slashes, "and" / "or", then an em dash: `**A**, **B** — text`.
const TERM_RUN = /^((?:\*\*[^*]+\*\*)(?:\s*(?:,|\/|and|or|,\s*and|,\s*or)\s*\*\*[^*]+\*\*)*)\s*—\s*([\s\S]*)$/;
// A second definition later on the same line: `… blending. **Tileset slot** — which …`.
const NEXT_TERM = /(?<=[.!?)])\s+(?=\*\*[^*]+\*\*\s*—\s)/;
const LEAD = /^\*\*([^*]+?)([:.])\*\*\s*([\s\S]+)$/;
const LEAD_OUTSIDE = /^\*\*([^*]+)\*\*:\s*([\s\S]+)$/;
const MENTION = /^\*\*([^*]+)\*\*\s+(?![—:])\S/;

// ---------------------------------------------------------------------------------------------------
// Parsing

type Block =
  | { type: 'heading'; level: number; md: string }
  | { type: 'para'; md: string }
  | { type: 'item'; md: string }
  | { type: 'table'; rows: string[][] };

function toBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] | null = null;
  let item: string[] | null = null;
  let table: string[][] | null = null;
  let fence = false;

  const flush = () => {
    if (para) blocks.push({ type: 'para', md: para.join(' ') });
    if (item) blocks.push({ type: 'item', md: item.join(' ') });
    if (table) blocks.push({ type: 'table', rows: table });
    para = item = table = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*(```|~~~)/.test(line)) { flush(); fence = !fence; continue; }
    if (fence) continue;
    if (!line.trim()) { flush(); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1].length, md: heading[2].trim() }); continue; }

    // Blockquote notes are asides, not definitions (and a `> ###` inside one is not a section).
    if (/^\s*>/.test(line)) { flush(); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flush(); continue; }

    if (/^\s*\|/.test(line)) {
      if (!table) { flush(); table = []; }
      const cells = splitRow(line.trim());
      // The `|---|---|` separator row.
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
      table.push(cells);
      continue;
    }

    const bullet = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) { flush(); item = [bullet[1]]; continue; }
    // A wrapped continuation of the current list item (indented) or paragraph.
    if (item && /^\s+\S/.test(raw)) { item.push(line.trim()); continue; }
    if (item) { flush(); }
    if (table) { flush(); }
    (para ??= []).push(line.trim());
  }
  flush();
  return blocks;
}

/** Definitions in one paragraph or list item (none, one, or several). */
type Definition = { kind: DocEntryKind; label: string; terms: string[]; parts?: string[]; body: string };

function definitionsIn(md: string): Definition[] {
  const text = md.trim();
  if (!text.startsWith('**')) return [];

  if (TERM_RUN.test(text)) {
    const out: Definition[] = [];
    for (const part of text.split(NEXT_TERM)) {
      const m = TERM_RUN.exec(part.trim());
      if (!m) continue;
      const { terms, parts } = boldTerms(m[1]);
      if (terms.length) out.push({ kind: 'term', label: plainText(m[1]), terms, parts, body: m[2].trim() });
    }
    return out;
  }

  const lead = LEAD.exec(text) ?? null;
  if (lead) return [{ kind: 'lead', label: plainText(lead[1]), terms: [plainText(lead[1])], body: lead[3].trim() }];
  const outside = LEAD_OUTSIDE.exec(text);
  if (outside) return [{ kind: 'lead', label: plainText(outside[1]), terms: [plainText(outside[1])], body: outside[2].trim() }];

  const mention = MENTION.exec(text);
  if (mention) return [{ kind: 'mention', label: plainText(mention[1]), terms: [plainText(mention[1])], body: text }];
  return [];
}

/** Parse one page. `id` is its path under docs/ without `.md`, e.g. `editor/rendering`. */
export function parsePage(id: string, markdown: string): DocPage {
  const page: DocPage = { id, title: id, headings: [], entries: [] };
  const blocks = toBlocks(markdown);

  // Index of the current real heading and of a pseudo-heading under it.
  let current = -1;
  let pseudo = -1;
  let skipping = false;
  /** The heading still waiting for its first prose paragraph. */
  let awaitingBody = -1;

  const under = () => (pseudo >= 0 ? pseudo : current);

  // GitHub numbers a repeated heading's anchor (`quality`, `quality-1`, …), so a link can reach either
  // and a region narrows to the right one. Bold-only pseudo-headings get no anchor on GitHub at all;
  // theirs only has to be unique, and must not shift the numbering of the real headings after it.
  const realSeen = new Map<string, number>();
  const taken = new Set<string>();
  const uniqueAnchor = (base: string, isPseudo: boolean): string => {
    let anchor = base;
    if (!isPseudo) {
      const n = realSeen.get(base) ?? 0;
      realSeen.set(base, n + 1);
      if (n) anchor = `${base}-${n}`;
    } else {
      for (let n = 1; taken.has(anchor); n++) anchor = `${base}-${n}`;
    }
    taken.add(anchor);
    return anchor;
  };

  const add = (kind: DocEntryKind, label: string, terms: string[], body: string, heading: number, meta: DocMeta[] = [], parts: string[] = []) => {
    const { keys, looseKeys, partKeys } = keysOf(terms, parts);
    if (!keys.length) return;
    page.entries.push({ page: id, kind, label, keys, looseKeys, partKeys, body, meta, heading });
  };

  for (const block of blocks) {
    if (block.type === 'heading') {
      const text = plainText(block.md);
      if (block.level === 1) {
        page.title = text;
        skipping = false;
        continue;
      }
      // The "See also" footer is a line of links, never a definition.
      skipping = block.level === 2 && /^see also$/i.test(text);
      if (skipping) { awaitingBody = -1; continue; }

      let parent = current;
      while (parent >= 0 && page.headings[parent].level >= block.level) parent = page.headings[parent].parent;
      page.headings.push({ level: block.level, text, anchor: uniqueAnchor(slugify(block.md), false), pseudo: false, parent });
      current = page.headings.length - 1;
      pseudo = -1;
      awaitingBody = current;
      continue;
    }
    if (skipping) continue;

    if (block.type === 'table') {
      const [header, ...rows] = block.rows;
      if (!header || header.length < 2) continue;
      for (const cells of rows) {
        if (!cells[0]?.startsWith('**')) continue;
        const { terms, parts } = boldTerms(cells[0]);
        if (!terms.length) continue;
        const bodyIndex = cells.length - 1;
        const body = bodyIndex > 0 ? cells[bodyIndex] : '';
        const meta: DocMeta[] = [];
        for (let i = 1; i < cells.length; i++) {
          if (i === bodyIndex || !cells[i] || !header[i]) continue;
          meta.push({ label: plainText(header[i]), value: cells[i] });
        }
        add('row', plainText(cells[0]), terms, body, under(), meta, parts);
      }
      continue;
    }

    // A short bold-only line is a sub-heading in all but name ("**Scripts**" in options.md); a long one
    // ending in a full stop is a bold list of values ("**Final, Lit Scene, Albedo, …**"), not a heading.
    if (block.type === 'para' && /^\*\*[^*]{1,48}\*\*$/.test(block.md.trim()) && !/\.\*\*$/.test(block.md.trim())) {
      const md = block.md.trim().slice(2, -2);
      const base = current >= 0 ? page.headings[current].level : 1;
      page.headings.push({ level: base + 1, text: plainText(md), anchor: uniqueAnchor(slugify(md), true), pseudo: true, parent: current });
      pseudo = page.headings.length - 1;
      awaitingBody = pseudo;
      continue;
    }

    const definitions = definitionsIn(block.md);
    for (const d of definitions) add(d.kind, d.label, d.terms, d.body, under(), [], d.parts);

    // A heading's body is its first plain paragraph: not a list item, and not itself a definition.
    if (awaitingBody >= 0 && block.type === 'para' && (definitions.length === 0 || definitions[0].kind === 'mention')) {
      const h = page.headings[awaitingBody];
      add('heading', h.text, [h.text], block.md.trim(), awaitingBody);
      awaitingBody = -1;
    }
  }

  // Headings that never got a paragraph still exist as regions; they simply resolve to nothing.
  return page;
}

/** Parse every page. Keys are page ids (`editor/rendering`), values the markdown. */
export function parseDocs(files: Record<string, string>): DocIndex {
  const pages = new Map<string, DocPage>();
  for (const [id, md] of Object.entries(files)) pages.set(id, parsePage(id, md));
  return { pages };
}

/** `…/docs/editor/rendering.md` (a glob key or an fs path) -> `editor/rendering`. */
export function pageIdFromPath(path: string): string {
  const unix = path.replace(/\\/g, '/');
  const at = unix.lastIndexOf('/docs/');
  const rel = at >= 0 ? unix.slice(at + '/docs/'.length) : unix.replace(/^docs\//, '');
  return rel.replace(/\.md$/i, '');
}

// ---------------------------------------------------------------------------------------------------
// Lookup

/** One link of the scope chain: a page, optionally narrowed to the subtree of one heading. */
export interface DocFrame {
  page: string;
  /** Anchor of a heading; lookups try its subtree before the whole page. */
  section?: string;
  /** Set when the frame came from a heading entry: fields may match rows inside it. */
  fields?: boolean;
}

const PRIORITY: Record<DocEntryKind, number> = { heading: 0, row: 1, term: 2, lead: 3, mention: 4 };
const FIELD_KINDS = new Set<DocEntryKind>(['row', 'term', 'lead']);

export function headingIndex(page: DocPage, anchor: string): number {
  // A real heading first: a pseudo-heading can only take an anchor no real heading had YET.
  const real = page.headings.findIndex(h => h.anchor === anchor && !h.pseudo);
  return real >= 0 ? real : page.headings.findIndex(h => h.anchor === anchor);
}

function inSubtree(page: DocPage, heading: number, root: number): boolean {
  for (let h = heading; h >= 0; h = page.headings[h].parent) if (h === root) return true;
  return false;
}

function best(entries: DocEntry[], key: string, loose: string, kinds?: Set<DocEntryKind>): DocEntry | null {
  let found: DocEntry | null = null;
  // Whole terms, then whole terms without a trailing parenthetical, then the parts of compound terms.
  for (const pass of [0, 1, 2] as const) {
    for (const e of entries) {
      if (!e.body.trim()) continue;
      if (kinds && !kinds.has(e.kind)) continue;
      const hit = pass === 0 ? e.keys.includes(key)
        : pass === 1 ? (loose !== '' && e.looseKeys.includes(loose))
        : e.partKeys.includes(key);
      if (hit && (!found || PRIORITY[e.kind] < PRIORITY[found.kind])) found = e;
    }
    if (found) return found;
  }
  return null;
}

function entriesUnder(page: DocPage, anchor: string | undefined): DocEntry[] | null {
  if (anchor === undefined) return page.entries;
  const root = headingIndex(page, anchor);
  if (root < 0) return null;
  return page.entries.filter(e => inSubtree(page, e.heading, root));
}

/**
 * Find the entry for a title (or a field label) through a scope chain, innermost frame first.
 *
 * - `title`: each frame's section, then that frame's whole page, then the next frame out.
 * - `field`: rows and term definitions only, and only inside the innermost heading region that allows
 *   fields, so a label like "Intensity" never borrows an unrelated row from elsewhere on the page.
 */
export function resolveTerm(index: DocIndex, frames: DocFrame[], text: string, mode: 'title' | 'field' = 'title'): DocEntry | null {
  const key = normalizeKey(text);
  const loose = looseKey(text);
  if (!key) return null;

  if (mode === 'field') {
    const frame = frames.find(f => f.section !== undefined);
    if (!frame?.fields) return null;
    const page = index.pages.get(frame.page);
    const entries = page && entriesUnder(page, frame.section);
    return entries ? best(entries, key, loose, FIELD_KINDS) : null;
  }

  const searchedPages = new Set<string>();
  for (const frame of frames) {
    const page = index.pages.get(frame.page);
    if (!page) continue;
    if (frame.section !== undefined) {
      const entries = entriesUnder(page, frame.section);
      const hit = entries && best(entries, key, loose);
      if (hit) return hit;
    }
    if (searchedPages.has(page.id)) continue;
    // A page-wide scope nested inside a region OF THE SAME PAGE (a sub-editor declaring the page its
    // parent already narrowed) must not jump ahead of that region: try the region first.
    const enclosing = frame.section === undefined
      ? frames.slice(frames.indexOf(frame) + 1).find(f => f.page === frame.page && f.section !== undefined)
      : undefined;
    if (enclosing) {
      const entries = entriesUnder(page, enclosing.section);
      const hit = entries && best(entries, key, loose);
      if (hit) return hit;
    }
    searchedPages.add(page.id);
    const hit = best(page.entries, key, loose);
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve an explicit `doc` key:
 * - `'Term'`               — looked up through the scope chain, like a title;
 * - `'page'`, `'page#anchor'` — that page's first heading entry / that heading;
 * - `'page::Term'`, `'page#anchor::Term'` — the term inside that page / that heading's subtree.
 */
export function resolveDocKey(index: DocIndex, frames: DocFrame[], doc: string, mode: 'title' | 'field' = 'title'): DocEntry | null {
  const [location, term] = doc.split('::');
  // Not `includes('/')`: a plain term may hold a slash ("Tone / Post"); a page id is a page that exists.
  const absolute = term !== undefined || location.includes('#') || index.pages.has(location);
  if (!absolute) return resolveTerm(index, frames, doc, mode);

  const [pageId, anchor] = location.split('#');
  const page = index.pages.get(pageId);
  if (!page) return null;
  if (term !== undefined) {
    const frame: DocFrame = { page: pageId, section: anchor || undefined, fields: true };
    return resolveTerm(index, [frame], term, 'title');
  }
  if (!anchor) return page.entries.find(e => e.kind === 'heading' && e.body.trim()) ?? null;
  const h = headingIndex(page, anchor);
  return page.entries.find(e => e.kind === 'heading' && e.heading === h && e.body.trim()) ?? null;
}

/** The frame a resolved entry opens for what sits inside its section. */
export function frameOf(index: DocIndex, entry: DocEntry): DocFrame | null {
  const page = index.pages.get(entry.page);
  const heading = page?.headings[entry.heading];
  if (!heading) return { page: entry.page };
  return { page: entry.page, section: heading.anchor, fields: entry.kind === 'heading' };
}

/** "Rendering › Renderer Settings" — where an entry sits, for the card's footer. */
export function breadcrumb(index: DocIndex, entry: DocEntry): string {
  const page = index.pages.get(entry.page);
  if (!page) return entry.page;
  const trail: string[] = [];
  let h = entry.kind === 'heading' ? page.headings[entry.heading]?.parent ?? -1 : entry.heading;
  for (; h >= 0; h = page.headings[h].parent) trail.unshift(page.headings[h].text);
  return [page.title, ...trail].join(' › ');
}
