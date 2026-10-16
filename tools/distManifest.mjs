// dist/package.json: the root manifest verbatim, with "types" repointed at the declaration tree's own
// root. Copied rather than hand-written because "dependencies" is load-bearing: `npm i file:../dist` in
// editor/ is what puts howler, uuid and sucrase into editor/node_modules, and the editor builds engine
// source that imports all three. Shared by buildDist.mjs (full build) and watchTypes.mjs (dev watch).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function writeDistManifest(root, dist = path.join(root, 'dist')) {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
    delete pkg.main;
    pkg.types = 'cleo.d.ts';
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
}
