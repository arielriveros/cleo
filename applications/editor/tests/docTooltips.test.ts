import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  breadcrumb, frameOf, looseKey, normalizeKey, parsePage, parseDocs, plainText, resolveDocKey, resolveTerm, slugify,
} from '../src/features/docs/parseDocs';
import { MODE_DOC_PAGE, MODE_PANEL_TITLES, PANEL_TAB_DOC_PAGE, PANEL_TAB_DOC_SECTION, PANEL_TITLES } from '../src/features/layout/panelTitles';
import { EDITOR_SRC, loadDocIndex, resolveSite, scanSource } from './support/docCoverage';

/**
 * The editor's title tooltips are not written in the editor: each Collapsable / Section / modal / dock
 * tab shows its entry from docs/**\/*.md (features/docs). Two things can break that silently — a title
 * the docs never describe, and a docs edit that renames the term a title was found by. Both leave a
 * title with no card and nothing else wrong, so this pins them: every literal title must resolve.
 *
 * `npx vite-node tools/docAudit.ts --misses` lists the same misses with file:line.
 */

const SAMPLE = `# Sample page

Intro paragraph.

## Common sections

| Section | Appears on | What it does |
|---|---|---|
| **Model** | Nodes with geometry | Which model asset it came from. |
| **Softness / Strength** | Shadows | Edge \\| blur. |
| **Empty** | Nowhere | |
| \`code\` | x | Not a UI term. |

### Cameras

**Camera** — projection and FOV.

**Sprite appearance** — tint, opacity. **Tileset slot** — which tileset a sprite uses.

1. **Node info** — name, node type, Delete.
- **Open scripts with** — *Cleo code editor*
  or an external one.

**Actions:** add, rename, delete.

**Occlusion** skips what is hidden.

### DecalNode — \`'decal'\` *(unreleased)*

A decal projects a material.

> ### Not a heading
> **Quoted** — not a definition.

\`\`\`
**Fenced** — not a definition.
\`\`\`

**Scripts**

The scripts group.

- **Script folder** — where scripts mirror to.

## See also

[Other](other.md) · **Linked** — ignored.
`;

describe('parsing the docs', () => {
  const page = parsePage('editor/sample', SAMPLE);
  const index = parseDocs({ 'editor/sample': SAMPLE });
  const find = (text: string, frames = [{ page: 'editor/sample' }]) => resolveTerm(index, frames, text);

  it('reads the title, headings and GitHub-style anchors', () => {
    expect(page.title).toBe('Sample page');
    expect(page.headings.map(h => h.anchor)).toEqual(['common-sections', 'cameras', 'decalnode--decal-unreleased', 'scripts']);
    expect(slugify("DecalNode — `'decal'` *(unreleased)*")).toBe('decalnode--decal-unreleased');
    expect(page.headings[3].pseudo).toBe(true);
  });

  it('takes a bold row\'s last column as the body and the others as meta', () => {
    const model = find('Model')!;
    expect(model.kind).toBe('row');
    expect(model.body).toBe('Which model asset it came from.');
    expect(model.meta).toEqual([{ label: 'Appears on', value: 'Nodes with geometry' }]);
    expect(breadcrumb(index, model)).toBe('Sample page › Common sections');
  });

  it('splits compound terms, keeps escaped pipes, and skips empty descriptions and code rows', () => {
    expect(find('Strength')?.label).toBe('Softness / Strength');
    expect(find('Softness / Strength')?.body).toBe('Edge \\| blur.');
    expect(find('Empty')).toBeNull();
    expect(find('code')).toBeNull();
  });

  it('reads `**Term** — text` in paragraphs, numbered items and bullets, two to a line', () => {
    expect(find('Camera')?.body).toBe('projection and FOV.');
    expect(find('Sprite appearance')?.body).toBe('tint, opacity.');
    expect(find('Tileset slot')?.body).toBe('which tileset a sprite uses.');
    expect(find('Node info')?.body).toBe('name, node type, Delete.');
    expect(find('Open scripts with')?.body).toBe('*Cleo code editor* or an external one.');
    expect(find('Actions')?.kind).toBe('lead');
    expect(find('Occlusion')?.kind).toBe('mention');
  });

  it('gives a heading its first paragraph, and a bold-only line the status of a heading', () => {
    expect(find('DecalNode — decal')?.body).toBe('A decal projects a material.');
    expect(find('Scripts')?.body).toBe('The scripts group.');
    expect(find('Script folder')?.heading).toBe(3);
  });

  it('ignores blockquotes, fenced code and the See also footer', () => {
    expect(find('Quoted')).toBeNull();
    expect(find('Not a heading')).toBeNull();
    expect(find('Fenced')).toBeNull();
    expect(find('Linked')).toBeNull();
  });

  it('matches titles regardless of case, markup, "&" / "/" and counts', () => {
    expect(normalizeKey('Tone / Post')).toBe(normalizeKey('Tone and post'));
    expect(normalizeKey('Ambient Occlusion & Indirect Light')).toBe('ambient occlusion and indirect light');
    expect(normalizeKey('Slots (3)')).toBe('slots');
    expect(looseKey('Passes (CPU / GPU)')).toBe('passes');
    expect(plainText('**A** [link](x.md#y) `code` *(unreleased)*')).toBe('A link code');
  });

  it('narrows by scope: a section first, fields only inside a heading region', () => {
    const cameras = find('Cameras')!;
    const frame = frameOf(index, cameras)!;
    expect(frame).toEqual({ page: 'editor/sample', section: 'cameras', fields: true });
    expect(resolveTerm(index, [frame], 'Camera', 'field')?.body).toBe('projection and FOV.');
    // A row on the same page but outside the region is not a field of this section.
    expect(resolveTerm(index, [frame], 'Model', 'field')).toBeNull();
    // A term entry's own frame never lets fields borrow its siblings.
    expect(resolveTerm(index, [frameOf(index, find('Model')!)!], 'Strength', 'field')).toBeNull();
  });

  it('numbers a repeated heading like GitHub, so each region narrows to its own section', () => {
    const md = '# P\n\n## Sky\n\nThe sky.\n\n### Quality\n\nSky quality.\n\n**Steps** — sky steps.\n\n## Clouds\n\nThe clouds.\n\n### Quality\n\nCloud quality.\n\n**Steps** — cloud steps.\n';
    const dup = parseDocs({ 'editor/dup': md });
    expect(dup.pages.get('editor/dup')!.headings.map(h => h.anchor)).toEqual(['sky', 'quality', 'clouds', 'quality-1']);
    const clouds = resolveTerm(dup, [{ page: 'editor/dup' }], 'Clouds')!;
    const quality = resolveTerm(dup, [frameOf(dup, clouds)!, { page: 'editor/dup' }], 'Quality')!;
    expect(quality.body).toBe('Cloud quality.');
    expect(resolveTerm(dup, [frameOf(dup, quality)!], 'Steps', 'field')?.body).toBe('cloud steps.');
    // A page-wide scope nested inside a region of the same page still tries that region first.
    expect(resolveTerm(dup, [{ page: 'editor/dup' }, frameOf(dup, clouds)!], 'Quality')?.body).toBe('Cloud quality.');
  });

  it('resolves explicit doc keys', () => {
    expect(resolveDocKey(index, [], 'editor/sample#cameras')?.label).toBe('Cameras');
    expect(resolveDocKey(index, [], 'editor/sample#common-sections::Strength')?.label).toBe('Softness / Strength');
    expect(resolveDocKey(index, [], 'editor/sample::Camera')?.body).toBe('projection and FOV.');
    expect(resolveDocKey(index, [{ page: 'editor/sample' }], 'Tileset slot')?.kind).toBe('term');
    expect(resolveDocKey(index, [], 'editor/missing#x')).toBeNull();
  });
});

describe('the real docs describe every editor title', () => {
  const index = loadDocIndex();
  const scan = scanSource();

  it('parses every page', () => {
    expect(index.pages.size).toBeGreaterThan(20);
    expect(resolveTerm(index, [{ page: 'editor/node-inspector' }], 'Transform')).not.toBeNull();
  });

  it('every DocScope names a page that exists, and every mode has one', () => {
    const missing = scan.scopes.filter(s => !index.pages.has(s.page)).map(s => `${s.file}:${s.line} ${s.page}`);
    expect(missing).toEqual([]);
    const modePages = Object.entries(MODE_DOC_PAGE).filter(([, page]) => !index.pages.has(page)).map(([m, p]) => `${m} -> ${p}`);
    expect(modePages).toEqual([]);
  });

  it('every literal Collapsable / Section / SectionTitle / ModalHeader title resolves', () => {
    const misses = scan.titles
      .map(site => resolveSite(index, site, scan.scopes))
      .filter(r => !r.entry && r.searched !== 'opted out')
      .map(r => `${r.site.file}:${r.site.line} ${r.site.component} "${r.site.title ?? r.site.doc ?? '(dynamic — give it a doc key)'}" (searched ${r.searched})`);
    expect(misses, `titles with no docs entry:\n${misses.join('\n')}`).toEqual([]);
  });

  it('every absolute doc key resolves', () => {
    // A bare page id is a scope (DocScope, MODE_DOC_PAGE), so for it existing is enough.
    const misses = scan.docKeys
      .filter(k => k.doc.includes('::') || k.doc.includes('#') || /^(editor|reference|scripting)\//.test(k.doc))
      .filter(k => (k.doc.includes('::') || k.doc.includes('#') ? !resolveDocKey(index, [], k.doc) : !index.pages.has(k.doc)))
      .map(k => `${k.file}:${k.line} ${k.doc}`);
    expect(misses).toEqual([]);
  });

  it('every mode in the mode selector has a row in "Modes you choose"', () => {
    const source = readFileSync(join(EDITOR_SRC, 'features', 'ModeSelector.tsx'), 'utf-8');
    const modes = [...source.matchAll(/<Segment\b[^>]*\bmode='([^']+)'/g)].map(m => m[1]);
    expect(modes.length).toBeGreaterThan(3);
    expect(modes.filter(m => !resolveDocKey(index, [], `editor/modes#modes-you-choose::${m}`))).toEqual([]);
  });

  it('every dock tab title has a row in the "Every panel" table', () => {
    const frame = [{ page: PANEL_TAB_DOC_PAGE, section: PANEL_TAB_DOC_SECTION }];
    const titles = [...new Set([...Object.values(PANEL_TITLES), ...MODE_PANEL_TITLES])];
    const misses = titles.filter(t => !resolveDocKey(index, frame, `${PANEL_TAB_DOC_PAGE}#${PANEL_TAB_DOC_SECTION}::${t}`));
    expect(misses).toEqual([]);
  });
});
