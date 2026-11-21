#!/usr/bin/env node
// Prints one release's CHANGELOG.md section to stdout: `node tools/changelogSection.mjs 1.1.2.5`.
//
// release.yml writes it to applications/app-kit/desktop/build/release-notes.md before building the installers,
// so electron-builder puts it in latest.yml as `releaseNotes` and the editor's Update button shows the same text
// Help ▸ About shows once the update is installed. One parser serves both: buildVersion.js.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { changelogSection } = createRequire(import.meta.url)(join(ROOT, 'applications/editor/buildVersion.js'));

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!version) {
    console.error('usage: node tools/changelogSection.mjs <version>   (e.g. 1.1.2.5)');
    process.exit(2);
}
const notes = changelogSection(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
if (notes === null) {
    console.error(`CHANGELOG.md has no section for v${version}`);
    process.exit(1);
}
process.stdout.write(`${notes}\n`);
