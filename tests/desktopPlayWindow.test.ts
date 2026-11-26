import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { compileFunction } from 'vm';
import { createRequire } from 'module';

/**
 * Play in window, pinned at the desktop shell's seams.
 *
 * The game window is a BrowserWindow the main process creates (applications/app-kit/desktop/playWindow.js),
 * opened and closed by the editor through the preload (`cleoDesktop.play`) and the typed view of it
 * (applications/editor/src/features/playWindow/desktopPlay.ts). Four files have to agree on channel names
 * across two process boundaries and a contextBridge, and nothing throws when they stop agreeing: an invoke
 * to a channel nobody handles rejects into a `.catch`, and Play quietly opens nothing.
 *
 * The two properties the window exists for are pinned too: it gets NO preload (the editor's file-system IPC
 * must stay out of reach of game scripts) and it is created by the main process, never by `window.open`
 * (which would keep it in the editor's renderer process).
 */

const ROOT = join(__dirname, '..');
const DESKTOP = join(ROOT, 'applications', 'app-kit', 'desktop');
const read = (...p: string[]) => readFileSync(join(...p), 'utf-8');
const MAIN = read(DESKTOP, 'main.js');
const PLAY = read(DESKTOP, 'playWindow.js');
const PRELOAD = read(DESKTOP, 'preload.js');
const BRIDGE = read(ROOT, 'applications', 'editor', 'src', 'features', 'playWindow', 'desktopPlay.ts');
const WEB = read(ROOT, 'applications', 'editor', 'src', 'features', 'playWindow', 'windowPlay.ts');
const PKG = JSON.parse(read(DESKTOP, 'package.json'));

/** renderer -> main. */
const INVOKED = ['play:open', 'play:close', 'play:focus'];
/** main -> renderer. */
const PUSHED = 'play:event';

const play = createRequire(import.meta.url)(join(DESKTOP, 'playWindow.js'));

describe('the desktop play window', () => {
  it('handles in main exactly what the preload invokes', () => {
    for (const channel of INVOKED) {
      expect(PRELOAD, `preload.js never invokes ${channel}`).toContain(`ipcRenderer.invoke('${channel}'`);
      expect(PLAY, `playWindow.js never handles ${channel}`).toContain(`ipcMain.handle('${channel}'`);
    }
    expect(PLAY).toContain(`send('${PUSHED}'`);
    expect(PRELOAD).toContain(`ipcRenderer.on('${PUSHED}'`);
  });

  it('exposes the bridge where the editor reads it', () => {
    expect(BRIDGE).toContain('cleoDesktop?.play');
    expect(PRELOAD).toMatch(/\bplay:\s*\{/);
    for (const method of ['open', 'close', 'focus', 'onEvent']) {
      expect(PRELOAD, `preload's play bridge has no ${method}`).toMatch(new RegExp(`\\b${method}\\s*:`));
      expect(BRIDGE, `desktopPlay.ts does not require ${method}`).toContain(`play.${method}`);
    }
  });

  it('gives the game window no preload, a sandbox, and a URL main builds itself', () => {
    const create = PLAY.slice(PLAY.indexOf('new BrowserWindow('), PLAY.indexOf('win.setMenuBarVisibility'));
    expect(create).toContain('sandbox: true');
    expect(create).toContain('contextIsolation: true');
    expect(create).toContain('nodeIntegration: false');
    expect(create).not.toMatch(/\bpreload\s*:/);
    // The page is always the game page of the app's own origin, whatever the renderer sent.
    expect(PLAY).toContain('`${appOrigin()}/play.html`');
    expect(PLAY).toMatch(/SESSION_ID\.test\(sessionId\)/);
  });

  it('never lets the desktop editor fall back to window.open for the game', () => {
    // windowPlay.ts opens a popup only on the web; inside an older shell it refuses instead.
    expect(WEB).toMatch(/if \(desktop\) \{[\s\S]*?desktop\.open\(/);
    expect(WEB).toMatch(/if \(oldShell\) return false/);
  });

  it('is wired into main, closing with the editor window that opened it', () => {
    expect(MAIN).toContain("require('./playWindow')");
    expect(MAIN).toMatch(/playWindow\.registerIpc\(/);
    expect(MAIN).toContain('play.closeOwnedBy(rendererId)');
  });

  it('ships in the packaged app', () => {
    expect(PKG.build.files).toContain('playWindow.js');
  });

  it('refuses a session id that is not one of ours', () => {
    expect(play.SESSION_ID.test('aaaabbbbccccdddd')).toBe(true);
    expect(play.SESSION_ID.test('../../etc')).toBe(false);
    expect(play.SESSION_ID.test('abc&x=1')).toBe(false);
    expect(play.SESSION_ID.test('')).toBe(false);
  });

  it('reopens where it was only while that is still on a screen', () => {
    const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 2560, height: 1400 }];
    expect(play.fitSavedBounds({ x: 2000, y: 100, width: 1280, height: 720 }, screens)).toEqual({ x: 2000, y: 100, width: 1280, height: 720 });
    // The second monitor is gone.
    expect(play.fitSavedBounds({ x: 2000, y: 100, width: 1280, height: 720 }, screens.slice(0, 1))).toBeNull();
    expect(play.fitSavedBounds({ x: 10, y: 10, width: 100, height: 100 }, screens)).toBeNull();
    expect(play.fitSavedBounds(null, screens)).toBeNull();
    expect(play.fitSavedBounds({ x: 'a' }, screens)).toBeNull();
  });

  it('opens centred on the editor\'s screen, never bigger than it', () => {
    expect(play.centredBounds({ x: 0, y: 0, width: 1920, height: 1040 }, 1280, 720)).toEqual({ x: 320, y: 160, width: 1280, height: 720 });
    expect(play.centredBounds({ x: 1920, y: 0, width: 1280, height: 680 }, 3840, 2160)).toEqual({ x: 1920, y: 0, width: 1280, height: 680 });
  });

  it('parses — none of the desktop files is loadable outside Electron, so nothing else would catch a typo', () => {
    // Compiled here, as Node wraps a CommonJS module, rather than by five `node --check` processes: starting a
    // process on a busy machine took seconds, and the five together outlasted the test's time in a full run.
    for (const file of ['main.js', 'preload.js', 'playWindow.js', 'playDebugger.js', 'debugPort.js']) {
      const path = join(DESKTOP, file);
      expect(() => compileFunction(readFileSync(path, 'utf8'), ['exports', 'require', 'module', '__filename', '__dirname'],
                                   { filename: path }), file).not.toThrow();
    }
  });
});

/**
 * The script debugger's relay (playDebugger.js): the editor drives the game window over the DevTools
 * protocol through the main process, which only it can do. The same three-file agreement as above, plus
 * what the relay lets through in each direction.
 */
describe('the script debugger relay', () => {
  const DEBUGGER = read(DESKTOP, 'playDebugger.js');
  const dbg = createRequire(import.meta.url)(join(DESKTOP, 'playDebugger.js'));
  const DEBUG_INVOKED = ['play:debug', 'play:debug-attach', 'play:raise-editor'];

  it('handles in main exactly what the preload invokes, and the editor reads it', () => {
    for (const channel of DEBUG_INVOKED) {
      expect(PRELOAD, `preload.js never invokes ${channel}`).toContain(`ipcRenderer.invoke('${channel}'`);
      expect(PLAY, `playWindow.js never handles ${channel}`).toContain(`ipcMain.handle('${channel}'`);
    }
    for (const method of ['debug', 'debugAttach', 'raiseEditor']) {
      expect(PRELOAD).toMatch(new RegExp(`\\b${method}\\s*:`));
      expect(BRIDGE, `desktopPlay.ts does not require ${method}`).toContain(`play.${method}`);
    }
    // Every event type the relay pushes is one the editor routes (and none of them reads as a crash).
    for (const type of ['debug', 'debug-attached', 'debug-detached']) {
      expect(DEBUGGER).toContain(`type: '${type}'`);
      expect(WEB).toContain(`case '${type}'`);
    }
    expect(PKG.build.files).toContain('playDebugger.js');
  });

  it('wires the VS Code debug port the same way: preload, main, bridge, the events the editor routes', () => {
    const PORT = read(DESKTOP, 'debugPort.js');
    for (const channel of ['debugport:set', 'play:vscode-release']) {
      expect(PRELOAD, `preload.js never invokes ${channel}`).toContain(`ipcRenderer.invoke('${channel}'`);
      expect(PORT, `debugPort.js never handles ${channel}`).toContain(`ipcMain.handle('${channel}'`);
    }
    for (const method of ['debugPort', 'vscodeRelease']) expect(BRIDGE).toContain(`play.${method}`);
    for (const type of ['vscode-status', 'vscode-ready', 'vscode-paused', 'vscode-resumed']) {
      expect(PORT).toContain(`type: '${type}'`);
      expect(WEB).toContain(`case '${type}'`);
    }
    expect(MAIN).toContain("require('./debugPort')");
    expect(MAIN).toMatch(/debugPort\.registerIpc\(/);
    expect(PKG.build.files).toContain('debugPort.js');
    // One debugger connection per window: Cleo's own debugger never attaches to a window the port holds.
    expect(PLAY).toMatch(/debugPort\.holds\(sessionId\)/);
    // Only this machine.
    expect(PORT).toContain("listen(p, '127.0.0.1'");
  });

  it('attaches on the first committed navigation, and detaches before a window is destroyed', () => {
    expect(PLAY).toMatch(/contents\.once\('did-navigate'[\s\S]*?attachDebugger\(/);
    const destroy = PLAY.slice(PLAY.indexOf('function destroy('), PLAY.indexOf("ipcMain.handle('play:open'"));
    expect(destroy.indexOf('debug.detach()')).toBeGreaterThan(-1);
    expect(destroy.indexOf('debug.detach()')).toBeLessThan(destroy.indexOf('.destroy()'));
  });

  it('lets through only the commands the debugger uses', () => {
    for (const method of ['Debugger.setBreakpointByUrl', 'Debugger.resume', 'Debugger.stepOver', 'Debugger.evaluateOnCallFrame', 'Runtime.getProperties'])
      expect(dbg.ALLOWED.has(method), method).toBe(true);
    for (const method of ['Page.navigate', 'Runtime.enable', 'Network.enable', 'Target.createTarget', 'Browser.close', 'DOM.setOuterHTML'])
      expect(dbg.ALLOWED.has(method), method).toBe(false);
  });

  it('passes on only user scripts\' parse events, trimmed, and the stop events', () => {
    expect(dbg.forwardEvent('Debugger.scriptParsed', { scriptId: '3', url: 'http://localhost:8080/src/core/engine.ts', hash: 'x' })).toBeNull();
    expect(dbg.forwardEvent('Debugger.scriptParsed', { scriptId: '4', url: '', hash: 'x' })).toBeNull();
    expect(dbg.forwardEvent('Debugger.scriptParsed', { scriptId: '5', url: 'cleo-script:///Player/Hero.ts', hash: 'h', startLine: 0, endLine: 40, executionContextAuxData: { big: true } }))
      .toEqual({ method: 'Debugger.scriptParsed', params: { scriptId: '5', url: 'cleo-script:///Player/Hero.ts', hash: 'h', startLine: 0, endLine: 40 } });
    expect(dbg.forwardEvent('Debugger.scriptParsed', { scriptId: '6', url: 'cleo-inline:///0a1b2c3d.ts' })?.params.url).toBe('cleo-inline:///0a1b2c3d.ts');
    for (const method of ['Debugger.paused', 'Debugger.resumed', 'Debugger.breakpointResolved'])
      expect(dbg.forwardEvent(method, { a: 1 })?.method).toBe(method);
    expect(dbg.forwardEvent('Runtime.consoleAPICalled', {})).toBeNull();
    expect(dbg.forwardEvent('Network.requestWillBeSent', {})).toBeNull();
  });

  it('ignores engine code and stops on every exception thrown through a script', () => {
    const [pattern] = dbg.IGNORE_PATTERNS.map((p: string) => new RegExp(p));
    expect(pattern.test('http://localhost:8080/src/core/engine.ts')).toBe(true);
    expect(pattern.test('app://editor/assets/play-123.js')).toBe(true);
    expect(pattern.test('cleo-script:///Player/Hero.ts')).toBe(false);
    expect(pattern.test('cleo-inline:///0a1b2c3d.ts')).toBe(false);
    expect(dbg.exceptionState(true)).toBe('all');
    expect(dbg.exceptionState(false)).toBe('none');
  });

  it('refuses a command it does not allow before it reaches the page, and anything once detached', async () => {
    const sent: string[] = [];
    let onDetach: ((e: unknown, reason: string) => void) | null = null;
    const contents = {
      isDestroyed: () => false,
      debugger: {
        attached: false,
        isAttached() { return this.attached; },
        attach() { this.attached = true; },
        detach() { this.attached = false; },
        on(event: string, fn: any) { if (event === 'detach') onDetach = fn; },
        removeListener() {},
        sendCommand: async (method: string) => { sent.push(method); return {}; },
      },
    };
    const events: any[] = [];
    const session = dbg.attachDebugger(contents, (e: any) => events.push(e), { pauseOnExceptions: true });
    await new Promise(r => setTimeout(r, 0));
    expect(sent).toEqual(['Debugger.enable', 'Debugger.setBlackboxPatterns', 'Debugger.setPauseOnExceptions']);
    expect(events).toEqual([{ type: 'debug-attached' }]);
    await expect(session.send('Page.navigate', {})).rejects.toThrow(/Not a debugger command/);
    await session.send('Debugger.resume');
    expect(sent.at(-1)).toBe('Debugger.resume');
    onDetach!(null, 'target closed');
    expect(events.at(-1)).toEqual({ type: 'debug-detached', reason: 'target closed' });
    await expect(session.send('Debugger.resume')).rejects.toThrow(/not attached/);
  });
});

describe('Play › Multiplayer join parameters (playWindow.joinQuery)', () => {
  const { joinQuery } = createRequire(import.meta.url)('../applications/app-kit/desktop/playWindow.js');
  const hash = 'Ysh4fI408UUvfFKNi9M7XZM7pEOxs7VgkW0AfRXlIoc=';

  it('passes a local dev host, a name and the network conditions into the game page’s address', () => {
    const q = new URLSearchParams(joinQuery({
      wt: 'https://localhost:4433/netsync', hash, ws: 'ws://127.0.0.1:4480/ws', name: 'Player 2', transport: 'websocket', lag: 75, jitter: 10, loss: 2.5,
    }).slice(1));
    expect(Object.fromEntries(q)).toEqual({
      wt: 'https://localhost:4433/netsync', ws: 'ws://127.0.0.1:4480/ws', hash, name: 'Player 2', transport: 'websocket', lag: '75', jitter: '10', loss: '2.5',
    });
    expect(joinQuery(undefined)).toBe('');
  });

  it('drops any host not on this machine and anything that is not a plain value', () => {
    expect(joinQuery({
      wt: 'https://example.com:4433/netsync', ws: 'ws://localhost:4480/ws"><script>', hash: 'not-a-hash', name: '<img src=x>',
      transport: 'quic', lag: '1e9', loss: -1,
    })).toBe('');
  });
});
