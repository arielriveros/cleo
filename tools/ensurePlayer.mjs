// Dev startup guard for the standalone game player (applications/editor/public/player/, git-ignored). Publishing
// fetches that bundle, so it has to exist and match the engine -- but rebuilding it on every
// `npm run editor:dev` / `desktop:dev` cost a full Vite library build each launch for a file most dev
// sessions never touch. It is rebuilt only when it is missing, built against an older player contract,
// or older than the newest engine/player source file.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const editor = path.join(root, 'applications', 'editor');
const out = path.join(editor, 'public', 'player');

function newestMtime(dir) {
    let newest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
    }
    return newest;
}

function staleReason() {
    if (!existsSync(path.join(out, 'game.js')) || !existsSync(path.join(out, 'build.json'))) return 'missing';
    const built = JSON.parse(readFileSync(path.join(out, 'build.json'), 'utf-8'));
    const { contract } = JSON.parse(readFileSync(path.join(editor, 'src/features/publish/playerContract.json'), 'utf-8'));
    if (built.contract !== contract) return `contract ${built.contract} -> ${contract}`;
    const sources = [path.join(root, 'src'), path.join(editor, 'src/player')];
    if (Math.max(...sources.map(newestMtime)) > Date.parse(built.builtAt)) return 'sources changed';
    return null;
}

const reason = staleReason();
if (!reason) {
    console.log('cleo: game player is up to date');
} else {
    console.log(`cleo: rebuilding game player (${reason})`);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const res = spawnSync(npm, ['run', 'build:player:only'], { cwd: editor, stdio: 'inherit', shell: process.platform === 'win32' });
    if (res.status !== 0) process.exit(res.status ?? 1);
}
