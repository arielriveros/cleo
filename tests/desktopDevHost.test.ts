import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

/**
 * Play › Multiplayer's dev host, run by the desktop editor (applications/app-kit/desktop/devHostProcess.js) so
 * nobody has to start `npm run host -- --dev` in a terminal. Pinned at the shell's seams, as the play window is:
 * the preload, main, the typed bridge (desktopPlay.ts) and the installer have to agree, and nothing throws when
 * they stop agreeing — the dialog would only go on saying "No dev host there".
 */

const ROOT = join(__dirname, '..');
const DESKTOP = join(ROOT, 'applications', 'app-kit', 'desktop');
const read = (...p: string[]) => readFileSync(join(...p), 'utf-8');
const MAIN = read(DESKTOP, 'main.js');
const PRELOAD = read(DESKTOP, 'preload.js');
const HOSTPROC = read(DESKTOP, 'devHostProcess.js');
const PLAY = read(DESKTOP, 'playWindow.js');
const BRIDGE = read(ROOT, 'applications', 'editor', 'src', 'features', 'playWindow', 'desktopPlay.ts');
const PKG = JSON.parse(read(DESKTOP, 'package.json'));
const dev = createRequire(import.meta.url)(join(DESKTOP, 'devHostProcess.js'));

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });
function serve(handler: (url: string) => [number, string]): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => { const [code, body] = handler(req.url ?? ''); res.writeHead(code); res.end(body); });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port));
  });
}

describe('the desktop dev host', () => {
  it('handles in main exactly what the preload invokes, and the editor reads it', () => {
    for (const channel of ['devhost:start', 'devhost:stop', 'devhost:status']) {
      expect(PRELOAD, `preload.js never invokes ${channel}`).toContain(`ipcRenderer.invoke('${channel}'`);
      expect(HOSTPROC, `devHostProcess.js never handles ${channel}`).toContain(`ipcMain.handle('${channel}'`);
    }
    expect(HOSTPROC).toContain(`send('devhost:event'`);
    expect(PRELOAD).toContain(`ipcRenderer.on('devhost:event'`);
    expect(BRIDGE).toContain('cleoDesktop?.devHost');
    for (const method of ['start', 'stop', 'onEvent']) expect(BRIDGE).toContain(`host.${method}`);
  });

  it('is wired into main and goes with the editor', () => {
    expect(MAIN).toContain("require('./devHostProcess')");
    expect(MAIN).toMatch(/devHostProcess\.registerIpc\(\{[^}]*utilityProcess/);
    expect(HOSTPROC).toContain("app.on('will-quit', stop)");
    // And the host itself stops when the editor is gone without saying so.
    expect(HOSTPROC).toContain("'--owner-pid', String(process.pid)");
  });

  it('ships in the installer with the built host and its packages', () => {
    expect(PKG.build.files).toContain('devHostProcess.js');
    const resources = PKG.build.extraResources.map((r: any) => `${r.from} -> ${r.to}`);
    expect(resources).toContain('../../host/dist -> host');
    expect(resources).toContain('../../host/node_modules -> host/node_modules');
  });

  it('tells a dev host from something else on the port, and from nothing', async () => {
    const devPort = await serve((url) => url === '/dev/endpoint'
      ? [200, JSON.stringify({ webTransport: { url: 'https://localhost:4433/netsync', certHashes: ['x'] }, webSocket: { url: 'ws://localhost:4480/ws' } })]
      : [404, '']);
    // A host started without --dev: the same control port, no /dev/endpoint.
    const otherPort = await serve(() => [404, '']);
    expect(await dev.probe(devPort)).toBe('dev');
    expect(await dev.probe(otherPort)).toBe('other');
    const closed = await serve(() => [200, '']);
    servers.pop()!.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await dev.probe(closed)).toBe('none');
  });

  it('runs the repository\'s host source from a dev build, and refuses an installed app built without it', () => {
    const cmd = dev.hostCommand({ isPackaged: false, getPath: () => '' });
    if (cmd.error) {
      // A checkout without the host's packages says how to install them.
      expect(cmd.error).toMatch(/npm run (host|apps):install/);
    } else {
      expect(cmd.kind).toBe('node');
      expect(cmd.cwd).toBe(join(ROOT, 'applications', 'host'));
      expect(cmd.args[0]).toMatch(/vite-node[\\/]vite-node\.mjs$/);
      expect(cmd.args.slice(1)).toEqual(['src/main.ts', '--']);
    }
    const saved = (process as any).resourcesPath;
    (process as any).resourcesPath = join(ROOT, 'no-such-resources');
    try {
      expect(dev.hostCommand({ isPackaged: true, getPath: () => '' }).error).toMatch(/without its dev host/);
    } finally {
      (process as any).resourcesPath = saved;
    }
  });

  it('lets Play › Multiplayer\'s windows stand side by side, where the editor placed them', () => {
    // A player's window never replaces another (Play in window keeps its one-window rule) nor takes the last
    // Play in window's spot.
    expect(PLAY).toMatch(/if \(!multiplayer\) for \(const entry of \[\.\.\.windows\.values\(\)\]\) if \(entry\.ownerId === ownerId && !entry\.multiplayer\) destroy\(entry\)/);
    expect(PLAY).toContain('const saved = multiplayer ? null');
    expect(PLAY).toMatch(/fitSavedBounds\(\{ x: options\.position\.x, y: options\.position\.y, width, height \}/);
  });

  it('parses — it is not loadable outside Electron, so nothing else would catch a typo', () => {
    expect(() => execFileSync(process.execPath, ['--check', join(DESKTOP, 'devHostProcess.js')])).not.toThrow();
  });
});
