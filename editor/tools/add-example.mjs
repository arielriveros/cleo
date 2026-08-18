#!/usr/bin/env node
// Ingest an exported project bundle as a bundled example project.
//
//   npm --prefix editor run examples:add -- <exported.cleoproj.zip> [options]
//
// The editor's Export button produces `<name>.cleoproj.zip`. This unzips it into
// `editor/public/examples/<slug>/`, writes a cover image, and regenerates `examples/index.json`. From there
// it is static content: CopyWebpackPlugin copies public/ into dist/, the Firebase workflow deploys dist/,
// and editor/src/utils/examples.ts fetches the folder back into a BundleData.
//
// Options:
//   --slug <s>         folder name (default: slugified project name from the manifest)
//   --name <s>         display name (default: the manifest's projectName, else the slug)
//   --description <s>  one-line blurb for the card
//   --order <n>        sort key in the gallery (default: keep existing, else 0)
//   --list             print the current catalogue and exit
//   --remove <slug>    delete an example folder, regenerate the index, and exit
//
// Per-example prose lives in `<slug>/example.json`, not in the index: the index is REGENERATED from a disk
// scan every run, so anything only stored there would be lost on the next ingest. Name/description/order
// are read back out of example.json and merged with whatever this run passes.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

// jszip is an editor dependency; resolving relative to this file finds editor/node_modules regardless of cwd.
const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const EDITOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES_DIR = path.join(EDITOR_DIR, 'public', 'examples');
const INDEX_FILE = path.join(EXAMPLES_DIR, 'index.json');

// ---- args -------------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) opts[arg.slice(2)] = argv[++i] ?? true;
    else opts._.push(arg);
  }
  return opts;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// ---- fs helpers -------------------------------------------------------------------------------

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function dirSize(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else total += (await fs.stat(full)).size;
  }
  return total;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// ---- the index ---------------------------------------------------------------------------------

/**
 * Rebuild index.json from what is on disk.
 *
 * Generated rather than edited so it can never claim an example that isn't there, or miss one that is —
 * the failure mode of a hand-maintained catalogue is a card that 404s halfway through a download.
 */
async function regenerateIndex() {
  await fs.mkdir(EXAMPLES_DIR, { recursive: true });
  const entries = [];

  for (const dirent of await fs.readdir(EXAMPLES_DIR, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const slug = dirent.name;
    const dir = path.join(EXAMPLES_DIR, slug);

    const manifest = await readJsonFile(path.join(dir, 'manifest.json'));
    if (!manifest) {
      console.warn(`  ! skipping ${slug}/ — no manifest.json`);
      continue;
    }
    const meta = (await readJsonFile(path.join(dir, 'example.json'))) ?? {};
    const textures = (await readJsonFile(path.join(dir, 'textures', 'index.json'))) ?? [];
    const hasThumb = await fs.access(path.join(dir, 'thumbnail.png')).then(() => true, () => false);

    entries.push({
      slug,
      name: meta.name || manifest.projectName || slug,
      ...(meta.description ? { description: meta.description } : {}),
      ...(hasThumb ? { thumbnail: `${slug}/thumbnail.png` } : {}),
      ...(meta.order !== undefined ? { order: meta.order } : {}),
      bytes: await dirSize(dir),
      sceneCount: (manifest.sceneMetas ?? []).length,
      textureCount: textures.length,
      createdAt: manifest.createdAt ?? 0,
    });
  }

  entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  await fs.writeFile(INDEX_FILE, JSON.stringify({ version: 1, examples: entries }, null, 2) + '\n');
  return entries;
}

function printCatalogue(entries) {
  if (!entries.length) {
    console.log('\n  No examples.\n');
    return;
  }
  console.log('');
  for (const e of entries) {
    console.log(`  ${e.slug.padEnd(28)} ${e.name.padEnd(28)} ${formatBytes(e.bytes).padStart(9)}  ` +
      `${e.sceneCount} scene(s), ${e.textureCount} texture(s)`);
  }
  console.log(`\n  ${entries.length} example(s), ${formatBytes(entries.reduce((n, e) => n + e.bytes, 0))} total\n`);
}

// ---- ingest -------------------------------------------------------------------------------------

/** The cover image, taken from the main scene's saved thumbnail. Absent is fine — the gallery has a glyph. */
async function writeThumbnail(dir, manifest) {
  const metas = manifest.sceneMetas ?? [];
  const main = metas.find(m => m.id === manifest.mainSceneId) ?? metas[0];
  const dataUrl = main?.thumbnail;
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:image\/\w+;base64,(.+)$/s);
  if (!match) return false;
  await fs.writeFile(path.join(dir, 'thumbnail.png'), Buffer.from(match[1], 'base64'));
  return true;
}

async function ingest(zipPath, opts) {
  const buffer = await fs.readFile(zipPath).catch(() => die(`Cannot read ${zipPath}`));
  const archive = await JSZip.loadAsync(buffer);

  const manifestFile = archive.file('manifest.json');
  if (!manifestFile) die(`${path.basename(zipPath)} has no manifest.json — is it a Cleo project export?`);
  const manifest = JSON.parse(await manifestFile.async('string'));
  if (manifest.formatVersion !== 1) die(`Unsupported bundle formatVersion ${manifest.formatVersion}`);
  if (manifest.kind !== 'project') {
    die(`This is a "${manifest.kind}" bundle. Examples must be full project exports, not asset packs.`);
  }

  const slug = slugify(opts.slug || manifest.projectName || path.basename(zipPath, '.zip'));
  if (!slug) die('Could not derive a slug — pass --slug');
  const dir = path.join(EXAMPLES_DIR, slug);

  // Read the existing prose BEFORE wiping the folder: a re-ingest of an updated export must not silently
  // drop a description someone wrote by hand.
  const previous = (await readJsonFile(path.join(dir, 'example.json'))) ?? {};

  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  let files = 0;
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue;
    const target = path.join(dir, entry.name);
    // A zip is untrusted input even when we made it: refuse anything that escapes the example folder.
    if (!target.startsWith(dir + path.sep)) die(`Refusing to write outside the example folder: ${entry.name}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await entry.async('nodebuffer'));
    files++;
  }

  await fs.writeFile(path.join(dir, 'example.json'), JSON.stringify({
    name: opts.name || previous.name || manifest.projectName || slug,
    description: opts.description ?? previous.description ?? '',
    order: opts.order !== undefined ? Number(opts.order) : (previous.order ?? 0),
  }, null, 2) + '\n');

  const gotThumb = await writeThumbnail(dir, manifest);
  const size = await dirSize(dir);

  console.log(`\n  ${slug}/  <-  ${path.basename(zipPath)}`);
  console.log(`    ${files} file(s), ${formatBytes(size)}${gotThumb ? '' : '  (no scene thumbnail in the export)'}`);
  if (size > 50 * 1024 * 1024) {
    console.log(`    ! ${formatBytes(size)} goes into git and into every deploy. Consider lighter art.`);
  }
  return slug;
}

// ---- main ----------------------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));

if (opts.list) {
  printCatalogue(await regenerateIndex());
} else if (opts.remove) {
  const dir = path.join(EXAMPLES_DIR, slugify(opts.remove));
  await fs.rm(dir, { recursive: true, force: true });
  console.log(`\n  Removed ${path.basename(dir)}/`);
  printCatalogue(await regenerateIndex());
} else if (!opts._.length) {
  console.log(`
  Usage: npm --prefix editor run examples:add -- <exported.cleoproj.zip> [options]

    --slug <s>         folder name (default: from the project name)
    --name <s>         display name shown on the card
    --description <s>  one-line blurb
    --order <n>        sort key in the gallery
    --list             print the catalogue
    --remove <slug>    delete an example
`);
  process.exit(1);
} else {
  await ingest(path.resolve(opts._[0]), opts);
  printCatalogue(await regenerateIndex());
  console.log('  Remember to commit editor/public/examples/.\n');
}
