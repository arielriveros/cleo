// Dev startup guard for the Electron shell (applications/app-kit/desktop). The shell is its own npm project,
// outside the applications/ workspace (electron-builder wants electron in a local node_modules), so neither
// the root install nor `npm ci` in applications/ installs it. Without it `desktop:dev` starts the dev server
// and then the Electron launch fails on a missing binary -- no window, one easily-missed line in the log. That is
// what happened after the shell moved from desktop/ to applications/app-kit/desktop: its node_modules stayed
// behind in the old folder. So install it here, once -- the same install `npm run desktop:install` does.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const shell = path.join(root, 'applications', 'app-kit', 'desktop');
// Written by electron's postinstall once the binary is downloaded; an interrupted install leaves it out.
const installed = existsSync(path.join(shell, 'node_modules', 'electron', 'path.txt'));

if (installed) {
    console.log('cleo: desktop shell dependencies are installed');
} else {
    console.log('cleo: installing the desktop shell dependencies (applications/app-kit/desktop, first run only)');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const res = spawnSync(npm, ['install'], { cwd: shell, stdio: 'inherit', shell: process.platform === 'win32' });
    if (res.status !== 0) process.exit(res.status ?? 1);
}
