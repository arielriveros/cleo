// `npm run watch:types`: the engine's dev-time declaration watcher. Dev never needs an engine BUILD --
// the editor dev server compiles engine source directly through the `cleo` alias (vite.config.ts), so
// engine edits hot-reload like editor edits. dist/ only feeds TYPES (Monaco, the script workspace,
// `npm run typecheck`), and a bare `tsc --watch` keeps that current except in the two cases a full
// `npm run build` used to be run for first:
//   - a fresh clone has no dist/package.json, so `cleo` does not resolve as a package at all;
//   - tsc overwrites but never deletes, so a .d.ts whose source was renamed or removed lingers and
//     surfaces in the editor as "Can't resolve './core/....d.ts'".
// Both are fixed here at startup, then tsc takes over in watch mode.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDistManifest } from './distManifest.mjs';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

/** Extensions a dist/X.d.ts can have been emitted from (allowJs brings in .js). */
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.d.ts'];

function pruneOrphans(dir) {
    let removed = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            removed += pruneOrphans(full);
            if (readdirSync(full).length === 0) rmSync(full, { recursive: true });
        } else if (entry.name.endsWith('.d.ts')) {
            const stem = path.join(src, path.relative(dist, full)).slice(0, -'.d.ts'.length);
            if (!SOURCE_EXTS.some(ext => existsSync(stem + ext))) { rmSync(full); removed++; }
        }
    }
    return removed;
}

if (existsSync(dist)) {
    const removed = pruneOrphans(dist);
    if (removed) console.log(`cleo: pruned ${removed} orphaned declaration(s) from dist/`);
}
writeDistManifest(root, dist);

const tsc = spawn(
    process.execPath,
    [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
     '-p', path.join(root, 'tsconfig.json'), '--emitDeclarationOnly', '--watch', '--preserveWatchOutput'],
    { stdio: 'inherit', cwd: root },
);
tsc.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => tsc.kill(sig));
