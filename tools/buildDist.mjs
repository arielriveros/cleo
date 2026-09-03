// `npm run build` for the engine. The engine publishes DECLARATIONS, not JavaScript: dist/ is a .d.ts
// tree plus the package.json that makes it resolvable as `cleo`.
//
// It used to be a webpack UMD bundle as well. Nothing loaded it -- the editor dev server, the editor
// build, the player build and both vitest suites all alias `cleo` to src/cleo.ts (see vite.config.ts)
// -- so every build spent its time on a 13 MB artifact with no reader. What dist/ is actually consumed
// for is the declaration tree:
//   - editor/src/features/nodeInspector/scriptEditor/cleoTypes.ts globs node_modules/cleo/**/*.d.ts and
//     feeds it to Monaco and to the on-disk script workspace an external IDE opens;
//   - editor/package.json's "cleo": "file:../dist" is how `cd editor && npm run typecheck` resolves a
//     bare `import ... from 'cleo'`;
//   - examples/scripts/tsconfig.json points `cleo` at ../../dist/cleo.
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = path.join(root, 'dist');

// `tsc --emitDeclarationOnly` overwrites but never deletes, so a declaration orphaned by a renamed or
// deleted source file would survive every later build. That matters more than it sounds: the editor
// holds this whole tree in its module graph as raw imports, and a tree that disagrees with the source
// surfaces there as a wall of "Can't resolve './core/base64.d.ts'" -- pointing at the consumer rather
// than at the build. This sweep is what webpack's `output.clean` used to do.
rmSync(dist, { recursive: true, force: true });

const tsc = spawnSync(
    process.execPath,
    [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
     '-p', path.join(root, 'tsconfig.json'), '--emitDeclarationOnly'],
    { stdio: 'inherit', cwd: root },
);
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

// The root manifest verbatim, with "types" repointed at the tree's own root. Copied rather than
// hand-written because "dependencies" is load-bearing: `npm i file:../dist` in editor/ is what puts
// howler, uuid and sucrase into editor/node_modules, and the editor builds engine source that imports
// all three. This is what CopyWebpackPlugin used to do.
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
delete pkg.main;
pkg.types = 'cleo.d.ts';

mkdirSync(dist, { recursive: true });
writeFileSync(path.join(dist, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');

console.log(`cleo: wrote declarations + package.json to ${path.relative(root, dist)}/`);
