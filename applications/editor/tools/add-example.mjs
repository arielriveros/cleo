#!/usr/bin/env node
// Make an exported project an example: a project folder in examples/<slug>/ (the examples' source of truth; the
// gallery bundle in public/examples/ is built from it, see tools/examples/gallery.mjs).
//
//   npm --prefix applications/editor run examples:add -- <exported.cleoproj.zip> --slug <s> [options]
//
// Options:
//   --slug <s>         folder name (default: slugified project name from the manifest)
//   --name <s>         display name (default: the manifest's projectName, else the slug)
//   --description <s>  one-line blurb for the card
//   --order <n>        sort key in the gallery (default: keep existing, else 0)
//   --list             print the examples: their data and their gallery bundles
//   --remove <slug>    delete an example's folder (and its gallery bundle)
//
// An existing folder is written over in place (its uid and tests kept), so re-adding an updated export of an
// example updates it. Then: npm run examples:publish <slug> (its binary data), and commit the folder.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleModules } from '../../../tools/exampleKit/editorModules.mjs';
import { folderSource } from '../../../tools/exampleKit/readExample.mjs';
import { EXAMPLES_DIR, listExamples, missingData, writeExampleFolder } from '../../../tools/exampleKit/folder.mjs';
import { GALLERY_DIR, formatBytes } from '../../../tools/exampleKit/galleryIndex.mjs';
import { writeExampleScaffold } from '../../../tools/examples/scaffold.mjs';
import { readme } from '../../../tools/examples/convert.mjs';

// jszip is an editor dependency; resolving relative to this file finds applications/editor/node_modules.
const require = createRequire(import.meta.url);
const JSZip = require('jszip');

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) opts[arg.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else opts._.push(arg);
  }
  return opts;
}

const slugify = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const die = (message) => { console.error(`\n  ${message}\n`); process.exit(1); };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

async function add(zipPath, opts) {
  if (!fs.existsSync(zipPath)) die(`Cannot read ${zipPath}`);
  const archive = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-example-'));
  try {
    for (const entry of Object.values(archive.files)) {
      if (entry.dir) continue;
      const target = path.join(work, entry.name);
      // A zip is untrusted input even when we made it: refuse anything that escapes the work folder.
      if (!target.startsWith(work + path.sep)) die(`Refusing to write outside the work folder: ${entry.name}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await entry.async('nodebuffer'));
    }
    const manifest = readJson(path.join(work, 'manifest.json'));
    if (!manifest) die(`${path.basename(zipPath)} has no manifest.json: is it a Cleo project export?`);
    if (manifest.kind !== 'project') die(`This is a "${manifest.kind}" bundle. Examples must be full project exports, not asset packs.`);
    const slug = slugify(opts.slug || manifest.projectName || path.basename(zipPath, '.zip'));
    if (!slug) die('Could not derive a slug: pass --slug');
    const dir = path.join(EXAMPLES_DIR, slug);
    const { bundle } = await bundleModules().readBundle(folderSource(work));
    const stats = await writeExampleFolder(dir, bundle, { name: manifest.projectName || slug });
    const previous = readJson(path.join(dir, 'example.json')) ?? {};
    const example = {
      name: opts.name || previous.name || manifest.projectName || slug,
      description: opts.description ?? previous.description ?? '',
      order: opts.order !== undefined ? Number(opts.order) : (previous.order ?? 0),
      createdAt: previous.createdAt ?? manifest.createdAt ?? Date.now(),
      ...(previous.tests ? { tests: previous.tests } : {}),
    };
    fs.writeFileSync(path.join(dir, 'example.json'), JSON.stringify(example, null, 2) + '\n');
    writeExampleScaffold(dir, slug);
    if (!fs.existsSync(path.join(dir, 'README.md'))) fs.writeFileSync(path.join(dir, 'README.md'), readme(slug, example));
    console.log(`\n  examples/${slug}/  <-  ${path.basename(zipPath)}: ${stats.written.length} file(s) written, ${stats.deleted.length} deleted`);
    console.log(`  Next: npm run examples:publish ${slug}, then commit examples/${slug}/.\n`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function list() {
  const index = readJson(path.join(GALLERY_DIR, 'index.json'))?.examples ?? [];
  console.log('');
  for (const { slug, dir } of listExamples()) {
    const example = readJson(path.join(dir, 'example.json')) ?? {};
    const missing = missingData(dir).length;
    const built = index.find((e) => e.slug === slug);
    console.log(`  ${slug.padEnd(16)} ${String(example.name ?? slug).padEnd(16)} ${missing ? `${missing} data file(s) missing`.padEnd(26) : 'data here'.padEnd(26)} ${built ? `gallery ${formatBytes(built.bytes)}` : 'not in the gallery'}`);
  }
  console.log('');
}

const opts = parseArgs(process.argv.slice(2));
if (opts.list) list();
else if (opts.remove) {
  const slug = slugify(opts.remove);
  fs.rmSync(path.join(EXAMPLES_DIR, slug), { recursive: true, force: true });
  fs.rmSync(path.join(GALLERY_DIR, slug), { recursive: true, force: true });
  console.log(`\n  Removed examples/${slug}/ (rebuild the gallery: npm run examples:bundle)\n`);
} else if (!opts._.length) {
  console.log(`
  Usage: npm --prefix applications/editor run examples:add -- <exported.cleoproj.zip> --slug <s> [options]

    --name <s>         display name shown on the card
    --description <s>  one-line blurb
    --order <n>        sort key in the gallery
    --list             the examples, their data and their gallery bundles
    --remove <slug>    delete an example
`);
  process.exit(1);
} else await add(path.resolve(opts._[0]), opts);
