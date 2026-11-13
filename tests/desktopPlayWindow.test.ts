import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
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
    for (const file of ['main.js', 'preload.js', 'playWindow.js']) {
      expect(() => execFileSync(process.execPath, ['--check', join(DESKTOP, file)])).not.toThrow();
    }
  });
});
