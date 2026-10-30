// Which editor titles find their docs entry, and which do not.
//
//   npx vite-node tools/docAudit.ts                     every literal title in src/
//   npx vite-node tools/docAudit.ts --misses            only the ones with no entry
//   npx vite-node tools/docAudit.ts src/features/rig    one folder (or file)
//   npx vite-node tools/docAudit.ts --page editor/animation src/features/rig
//                                                       resolve files with no DocScope of their own
//                                                       through this page (the panel's), not all pages
//
// A title the source cannot show (an expression) is listed as "dynamic": give it a `doc` key.
// The running editor's own list is `window.cleoDocs.misses()` in dev.
import { statSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { breadcrumb } from '../../app-kit/src/docs/parseDocs';
import { loadDocIndex, resolveSite, scanSource } from '../tests/support/docCoverage';

const args = process.argv.slice(2);
const missesOnly = args.includes('--misses');
const pageAt = args.indexOf('--page');
const fallbackPages = pageAt >= 0 ? [args[pageAt + 1]] : undefined;
const targets = args.filter((a, i) => !a.startsWith('--') && (pageAt < 0 || i !== pageAt + 1));

function tsxUnder(path: string, out: string[] = []): string[] {
  if (statSync(path).isDirectory()) { for (const n of readdirSync(path)) tsxUnder(join(path, n), out); }
  else if (path.endsWith('.tsx')) out.push(path);
  return out;
}

const index = loadDocIndex();
const files = targets.length ? targets.flatMap(t => tsxUnder(resolve(t))) : undefined;
const scan = scanSource(files);

let hits = 0;
let misses = 0;
for (const site of scan.titles) {
  const r = resolveSite(index, site, scan.scopes, fallbackPages);
  const where = `${site.file}:${site.line}`;
  const label = site.title ?? (site.doc ? `doc=${site.doc}` : '(dynamic)');
  if (r.entry) {
    hits++;
    if (!missesOnly) console.log(`ok    ${where}  ${site.component} "${label}" -> ${breadcrumb(index, r.entry)} [${r.entry.kind}: ${r.entry.label}]`);
  } else if (r.searched !== 'opted out') {
    misses++;
    console.log(`MISS  ${where}  ${site.component} "${label}"  (${r.searched})`);
  }
}
for (const k of scan.docKeys) {
  const [location] = k.doc.split('::');
  const pageId = location.split('#')[0];
  if ((location.includes('#') || k.doc.includes('::') || index.pages.has(pageId)) && !index.pages.has(pageId)) {
    misses++;
    console.log(`MISS  ${k.file}:${k.line}  doc key "${k.doc}" names no page`);
  }
}
for (const s of scan.scopes) {
  if (!index.pages.has(s.page)) { misses++; console.log(`MISS  ${s.file}:${s.line}  DocScope page "${s.page}" does not exist`); }
}
console.log(`\n${hits} resolved, ${misses} missing`);
