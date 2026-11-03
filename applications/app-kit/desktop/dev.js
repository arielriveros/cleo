// `npm run dev`: Electron against the editor's dev server (CLEO_DEV=1, see main.js).
//
// A launcher rather than `electron .` because of ELECTRON_RUN_AS_NODE. VS Code sets it for every process its
// extension host spawns (tasks, agents, extension terminals), and a child inherits it: Electron then starts
// as plain Node, `require('electron')` is a path string, main.js dies on `protocol.registerSchemesAsPrivileged`
// and no window ever opens. Setting it to an empty string is not enough on Windows — the variable still
// exists — so it is removed from the child's environment outright.
const { spawn } = require('child_process');
// Under plain Node this package's `electron` export is the path to the binary.
const electron = require('electron');

const env = { ...process.env, CLEO_DEV: '1' };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.'], { cwd: __dirname, env, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
