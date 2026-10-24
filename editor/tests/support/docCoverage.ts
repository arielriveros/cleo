import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { parseDocs, resolveDocKey, resolveTerm, type DocEntry, type DocFrame, type DocIndex } from '../../src/features/docs/parseDocs';

// Shared by docTooltips.test.ts and tools/docAudit.ts: the docs read off disk, and every literal title in
// the editor's source matched against them the way the running editor would.

export const ENGINE_ROOT = join(__dirname, '..', '..', '..');
export const DOCS_DIR = join(ENGINE_ROOT, 'docs');
export const EDITOR_SRC = join(ENGINE_ROOT, 'editor', 'src');

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, ext, out);
    else if (name.endsWith(ext)) out.push(path);
  }
  return out;
}

const unix = (p: string) => p.split('\\').join('/');

export function loadDocIndex(): DocIndex {
  const files: Record<string, string> = {};
  for (const path of walk(DOCS_DIR, '.md')) files[unix(relative(DOCS_DIR, path)).replace(/\.md$/, '')] = readFileSync(path, 'utf-8');
  return parseDocs(files);
}

/** Components whose `title` gets a docs card. */
export const TITLED = ['Collapsable', 'Section', 'SectionTitle', 'ModalHeader'] as const;

export interface TitleSite {
  file: string;
  line: number;
  component: string;
  /** The literal title, or undefined when it is an expression. */
  title?: string;
  /** The literal `doc` key, `false` for `doc={false}`. */
  doc?: string | false;
}

export interface ScopeSite { file: string; line: number; page: string; section?: string }

/** The attribute text of a JSX opening tag starting at `start` (just after `<Name`), braces and strings respected. */
function tagAttributes(src: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote && src[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(start, i);
  }
  return src.slice(start);
}

/** A string attribute's literal value: `a='x'`, `a="x"`, `a={'x'}`; `false` for `a={false}`. */
function literalAttribute(attrs: string, name: string): string | false | undefined {
  const m = new RegExp(`(?:^|\\s)${name}=(?:'([^']*)'|"([^"]*)"|\\{'([^']*)'\\}|\\{"([^"]*)"\\}|\\{(false)\\})`).exec(attrs);
  if (!m) return undefined;
  if (m[5]) return false;
  return m[1] ?? m[2] ?? m[3] ?? m[4];
}

const lineAt = (src: string, index: number) => src.slice(0, index).split('\n').length;

/** Whether `index` sits in a comment: after `//` on its line, or inside a block comment. */
function inComment(src: string, index: number): boolean {
  const lineStart = src.lastIndexOf('\n', index - 1) + 1;
  if (/(^|[^:'"`])\/\//.test(src.slice(lineStart, index))) return true;
  const open = src.lastIndexOf('/*', index);
  return open >= 0 && src.indexOf('*/', open) > index;
}

export interface SourceScan { titles: TitleSite[]; scopes: ScopeSite[]; docKeys: { file: string; line: number; doc: string }[] }

export function scanSource(files = [...walk(EDITOR_SRC, '.tsx'), ...walk(EDITOR_SRC, '.ts')]): SourceScan {
  const scan: SourceScan = { titles: [], scopes: [], docKeys: [] };
  for (const path of files) {
    const src = readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
    const file = unix(relative(EDITOR_SRC, path));

    for (const m of src.matchAll(/<(Collapsable|Section|SectionTitle|ModalHeader|DocScope)\b/g)) {
      if (inComment(src, m.index!)) continue;
      const attrs = tagAttributes(src, m.index! + m[0].length);
      const line = lineAt(src, m.index!);
      if (m[1] === 'DocScope') {
        const page = literalAttribute(attrs, 'page');
        const section = literalAttribute(attrs, 'section');
        if (typeof page === 'string') scan.scopes.push({ file, line, page, section: typeof section === 'string' ? section : undefined });
        continue;
      }
      // A primitive handing down an entry it already resolved (Section -> SectionTitle) is not a site.
      if (/(?:^|\s)entry=/.test(attrs)) continue;
      // A ModalHeader with no title is a container: its caption is a SectionTitle inside, scanned on its own.
      if (m[1] === 'ModalHeader' && !/(?:^|\s)(?:title|doc)=/.test(attrs)) continue;
      const title = literalAttribute(attrs, 'title');
      const doc = literalAttribute(attrs, 'doc');
      scan.titles.push({ file, line, component: m[1], title: typeof title === 'string' ? title : undefined, doc });
    }
    // `doc` keys on anything else (Field, PropertyRow, segmented options written as object literals).
    for (const m of src.matchAll(/\bdoc(?:=|:\s*)(?:'([^']+)'|"([^"]+)")/g)) {
      if (inComment(src, m.index!)) continue;
      scan.docKeys.push({ file, line: lineAt(src, m.index!), doc: m[1] ?? m[2] });
    }
    // Any other quoted absolute key ('editor/interface#menu-bar::Projects'), wherever it is passed.
    for (const m of src.matchAll(/(?<![\w/.])'((?:editor|reference|scripting)\/[a-z0-9-]+(?:#[a-z0-9-]*)?(?:::[^']+)?)'/g)) {
      if (inComment(src, m.index!) || /doc(?:=|:\s*)$/.test(src.slice(Math.max(0, m.index! - 8), m.index!))) continue;
      scan.docKeys.push({ file, line: lineAt(src, m.index!), doc: m[1] });
    }
  }
  return scan;
}

export interface Resolution { site: TitleSite; entry: DocEntry | null; searched: string }

/**
 * Resolve one title the way the editor would, as far as the source shows it: through the DocScopes
 * declared in its own file first, then — standing in for the scopes of whatever hosts it, which the
 * source of one file cannot show — through `fallbackPages` (every editor page, by default). The
 * running editor's `window.cleoDocs.misses()` is the exact check; this one catches a title the docs
 * describe nowhere, or describe under another name.
 */
export function resolveSite(index: DocIndex, site: TitleSite, scopes: ScopeSite[], fallbackPages?: string[]): Resolution {
  const own = scopes.filter(s => s.file === site.file).map<DocFrame>(s => ({ page: s.page, section: s.section, fields: s.section !== undefined }));
  const pages = fallbackPages ?? [...index.pages.keys()].filter(p => p.startsWith('editor/'));
  const frames = [...own, ...pages.map<DocFrame>(page => ({ page }))];
  const searched = [...own.map(f => f.page), fallbackPages ? fallbackPages.join(', ') : `${pages.length} editor pages`].join(', then ');
  if (site.doc === false) return { site, entry: null, searched: 'opted out' };
  if (site.doc) return { site, entry: resolveDocKey(index, frames, site.doc), searched };
  if (site.title === undefined) return { site, entry: null, searched: 'dynamic title without doc' };
  return { site, entry: resolveTerm(index, frames, site.title), searched };
}
