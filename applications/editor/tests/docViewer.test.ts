import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync } from 'fs';
import { join, posix } from 'path';
import type { Token, Tokens } from 'marked';
import { parsePage, plainText, resolveDocLink, type DocIndex } from '@cleo/app-kit/docs/parseDocs';
import { getDocSource, pageOrder, registerDocSources } from '@cleo/app-kit/docs/docIndex';
import { DocFramesContext } from '@cleo/app-kit/docs/DocScope';
import { framesFromFiber } from '@cleo/app-kit/docs/docTargets';
import { cardMeta, summarize } from '@cleo/app-kit/ui/DocTooltip';
import { headingIds, lexDocs, MarkdownView } from '@cleo/app-kit/docs/viewer/markdown';
import { highlight } from '@cleo/app-kit/docs/viewer/highlight';
import { searchDocs } from '@cleo/app-kit/docs/viewer/docSearch';
import {
  getDocsViewerState, goBack, goForward, openDocs, closeDocs,
} from '@cleo/app-kit/docs/viewer/docsViewerStore';
import { DOCS_DIR, loadDocIndex } from './support/docCoverage';

/**
 * Help > Documentation renders docs/**\/*.md in the app (app-kit docs/viewer), and F1 / What's This? jump
 * to an entry by its SOURCE LINE: parseDocs records the line of every entry, the renderer tags every
 * block, list item and table row with `data-line`, and the two must agree. These pin that agreement on
 * the real docs, plus every relative link, so a docs edit cannot leave a jump or a link landing nowhere.
 */

const index: DocIndex = loadDocIndex();
const sourceOf = (page: string) => readFileSync(join(DOCS_DIR, `${page}.md`), 'utf-8');
const pages = [...index.pages.keys()];

function render(page: string, source = sourceOf(page)): string {
  return renderToStaticMarkup(createElement(MarkdownView, {
    page, source, hasPage: (id: string) => index.pages.has(id), onLink: () => {},
  }));
}

const dataLines = (html: string) => new Set([...html.matchAll(/data-line="(\d+)"/g)].map(m => Number(m[1])));

describe('entry source lines', () => {
  it('every entry points at the line its term is written on', () => {
    const wrong: string[] = [];
    for (const page of index.pages.values()) {
      const lines = sourceOf(page.id).replace(/\r\n?/g, '\n').split('\n');
      for (const e of page.entries) {
        // A paragraph can define a second term on a wrapped line, so look a few lines on.
        const block = plainText(lines.slice(e.line - 1, e.line + 7).join(' ')).toLowerCase();
        if (!block.includes(plainText(e.label).toLowerCase())) wrong.push(`${page.id}:${e.line} "${e.label}" (${e.kind})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('records lines for headings, rows and terms', () => {
    const page = parsePage('t', '# T\n\n## Shadows\n\nCast shadows.\n\n| Name | Does |\n|---|---|\n| **Bias** | Offset. |\n\n**Term** — a definition.\n');
    const byLabel = Object.fromEntries(page.entries.map(e => [e.label, e.line]));
    expect(byLabel).toEqual({ Shadows: 3, Bias: 9, Term: 11 });
    expect(page.headings[0].line).toBe(3);
  });
});

describe('the markdown renderer', () => {
  it('renders every page, with a data-line wherever an entry can be jumped to', () => {
    const missing: string[] = [];
    for (const page of pages) {
      const html = render(page);
      expect(html.length).toBeGreaterThan(0);
      const tagged = dataLines(html);
      for (const e of index.pages.get(page)!.entries) {
        if (!tagged.has(e.line)) missing.push(`${page}:${e.line} "${e.label}" (${e.kind})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps an escaped pipe inside a code span in a table cell', () => {
    const html = render('t', '| A | B |\n|---|---|\n| **x** | `a \\| b` |\n');
    expect(html).toContain('a | b</code>');
    expect(html).toContain('data-line="3"');
  });

  it('shows images as captions, never loading them', () => {
    const html = render('editor/x', '![The Valley at dusk](../media/valley.jpg)\n');
    expect(html).toContain('The Valley at dusk');
    expect(html).not.toContain('<img');
  });

  it('marks (unreleased) as a badge and gives headings GitHub ids', () => {
    const html = render('t', '# T\n\n## Particles *(unreleased)*\n\n## Quality\n\n## Quality\n');
    expect(html).toContain('id="particles-unreleased"');
    expect(html).toContain('id="quality"');
    expect(html).toContain('id="quality-1"');
    expect(html).toContain('unreleased</span>');
  });

  it('renders links to pages that are not bundled as inert text', () => {
    const html = render('editor/x', '[examples](../../examples/scripts/README.md) and [physics](physics.md)\n');
    expect(html).toContain('Not in the bundled docs');
    expect(html).toContain('href="physics.md"');
  });
});

describe('links between pages', () => {
  function links(tokens: Token[], out: string[] = []): string[] {
    for (const t of tokens) {
      if (t.type === 'link') out.push((t as Tokens.Link).href);
      const nested = t as { tokens?: Token[]; items?: Tokens.ListItem[]; header?: Tokens.TableCell[]; rows?: Tokens.TableCell[][] };
      if (nested.tokens) links(nested.tokens, out);
      if (nested.items) for (const item of nested.items) links(item.tokens, out);
      if (nested.header) for (const c of nested.header) links(c.tokens, out);
      if (nested.rows) for (const row of nested.rows) for (const c of row) links(c.tokens, out);
    }
    return out;
  }

  const anchorsOf = new Map<string, Set<string>>();
  const anchors = (page: string) => {
    if (!anchorsOf.has(page)) anchorsOf.set(page, new Set(headingIds(lexDocs(sourceOf(page))).values()));
    return anchorsOf.get(page)!;
  };

  it('every relative link reaches a bundled page and an existing heading, or deliberately leaves docs/', () => {
    const broken: string[] = [];
    for (const page of pages) {
      for (const href of links(lexDocs(sourceOf(page)))) {
        const link = resolveDocLink(page, href);
        if (link.kind === 'external') continue;
        if (link.kind === 'outside') {
          // A file in docs/ that is not a page (a sample script beside the page that shows it) must exist.
          const inDocs = posix.normalize(posix.join(posix.dirname(page), href.split('#')[0]));
          if (!inDocs.startsWith('..')) {
            if (!existsSync(join(DOCS_DIR, inDocs))) broken.push(`${page}: ${href} (no file docs/${inDocs})`);
            continue;
          }
          // The few links out of docs/: the example projects, the changelog, the media tooling.
          if (!/^(\.\.\/)+(examples|CHANGELOG\.md|tools)\b/.test(href)) broken.push(`${page}: ${href} (outside docs/)`);
          continue;
        }
        if (!index.pages.has(link.page)) { broken.push(`${page}: ${href} (no page ${link.page})`); continue; }
        if (link.anchor && !anchors(link.page).has(link.anchor)) broken.push(`${page}: ${href} (no heading #${link.anchor})`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('resolves relative paths, anchors and schemes', () => {
    expect(resolveDocLink('editor/rendering', 'physics.md#joints')).toEqual({ kind: 'page', page: 'editor/physics', anchor: 'joints' });
    expect(resolveDocLink('editor/rendering', '../reference/node-types.md')).toEqual({ kind: 'page', page: 'reference/node-types', anchor: undefined });
    expect(resolveDocLink('editor/rendering', '#shadows')).toEqual({ kind: 'page', page: 'editor/rendering', anchor: 'shadows' });
    expect(resolveDocLink('README', 'editor/interface.md')).toEqual({ kind: 'page', page: 'editor/interface', anchor: undefined });
    expect(resolveDocLink('editor/x', '../../CHANGELOG.md')).toEqual({ kind: 'outside', path: '../../CHANGELOG.md' });
    expect(resolveDocLink('editor/x', 'https://example.com/a')).toEqual({ kind: 'external', href: 'https://example.com/a' });
  });
});

describe('the docs store', () => {
  it('orders pages as the README links them, README first', () => {
    const files: Record<string, string> = {};
    for (const page of pages) files[`/docs/${page}.md`] = sourceOf(page);
    registerDocSources(files);
    const order = pageOrder();
    expect(order[0]).toBe('README');
    expect(new Set(order)).toEqual(new Set(pages));
    expect(order.indexOf('editor/interface')).toBeLessThan(order.indexOf('reference/node-types'));
    expect(getDocSource('editor/interface')).toBe(sourceOf('editor/interface'));
  });

  it('keeps back / forward history', () => {
    openDocs({ page: 'a' });
    openDocs({ page: 'b', line: 4 });
    openDocs({ page: 'c' });
    goBack();
    expect(getDocsViewerState().current).toMatchObject({ page: 'b', line: 4 });
    goBack();
    expect(getDocsViewerState().current?.page).toBe('a');
    goForward();
    expect(getDocsViewerState().current?.page).toBe('b');
    openDocs({ page: 'd' });
    expect(getDocsViewerState().forward).toEqual([]);
    closeDocs();
    expect(getDocsViewerState().open).toBe(false);
    openDocs();
    expect(getDocsViewerState()).toMatchObject({ open: true, current: { page: 'd' } });
  });
});

describe('search', () => {
  it('finds a section by name and ranks it above body text', () => {
    const hits = searchDocs(index, 'shadows');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some(h => h.target.page === 'editor/rendering')).toBe(true);
    expect(hits[0].label.toLowerCase()).toContain('shadow');
    expect(searchDocs(index, 'x')).toEqual([]);
  });
});

describe('hover cards are concise', () => {
  it('keeps the first sentence only', () => {
    expect(summarize('Casts the shadows of everything the sun lights, in cascades. Each cascade covers a band of distance.'))
      .toBe('Casts the shadows of everything the sun lights, in cascades.');
  });

  it('takes a second sentence when the first is a fragment', () => {
    expect(summarize('Off by default. Turn it on to cast shadows.')).toBe('Off by default. Turn it on to cast shadows.');
  });

  it('cuts one long sentence at a word, as plain text', () => {
    const long = `A **very** long sentence ${'that keeps going '.repeat(20)}to the end.`;
    const out = summarize(long);
    expect(out.length).toBeLessThanOrEqual(202);
    expect(out.endsWith(' …')).toBe(true);
    expect(out).not.toContain('**');
  });

  it('keeps only short extra columns', () => {
    const [entry] = parsePage('t', '| Name | Default | Notes | Does |\n|---|---|---|---|\n| **Bias** | 0.5 | '
      + 'x'.repeat(60) + ' | Offset. |\n').entries;
    expect(cardMeta(entry)).toEqual([{ label: 'Default', value: '0.5' }]);
  });
});

describe("What's This? reads the docs scope off React's fibers", () => {
  it('relies on the provider shape of the installed React', () => {
    expect((DocFramesContext.Provider as unknown as { _context: unknown })._context).toBe(DocFramesContext);
  });

  it('takes the nearest provider value, skipping consumers and plain fibers', () => {
    const frames = [{ page: 'editor/rendering', section: 'shadows' }];
    const outer = { type: DocFramesContext.Provider, memoizedProps: { value: [{ page: 'editor/interface' }] }, return: null };
    const provider = { type: DocFramesContext.Provider, memoizedProps: { value: frames }, return: outer };
    const consumer = { type: { _context: DocFramesContext }, memoizedProps: { children: null }, return: provider };
    const leaf = { type: 'button', memoizedProps: {}, return: { type: () => null, memoizedProps: {}, return: consumer } };
    expect(framesFromFiber(leaf)).toBe(frames);
    expect(framesFromFiber({ type: 'div', memoizedProps: {}, return: null })).toBeNull();
    // React 19's shape: the context object itself is the provider type.
    expect(framesFromFiber({ type: DocFramesContext, memoizedProps: { value: frames }, return: null })).toBe(frames);
  });
});

describe('code highlighting', () => {
  it('classifies keywords, strings, numbers, comments and calls', () => {
    const runs = highlight("const a = load('x', 2); // done", 'ts');
    const kinds = Object.fromEntries(runs.filter(r => r.kind !== 'plain').map(r => [r.text.trim(), r.kind]));
    expect(kinds).toMatchObject({ const: 'keyword', load: 'function', "'x'": 'string', '2': 'number', '// done': 'comment' });
    expect(highlight('plain tree', undefined)).toEqual([{ kind: 'plain', text: 'plain tree' }]);
    expect(runs.map(r => r.text).join('')).toBe("const a = load('x', 2); // done");
  });
});
