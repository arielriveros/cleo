import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { EventEmitter } from 'events';

/**
 * The desktop editor updating itself from GitHub Releases, pinned at its seams.
 *
 * app-kit/desktop/desktopUpdater.js checks with electron-updater and pushes its state to every window; the
 * preload (`cleoDesktop.updater`) and its typed view (app-kit/src/platform/desktopUpdater.ts) carry it to the menu
 * bar's Update button. None of it throws when the halves stop agreeing: an invoke nobody handles rejects into a
 * `void`, and a state nobody sends leaves the button hidden for good. Nor does a release that cannot be found:
 * the 4-part tag (`v1.1.2.5`) only works while the updater reads it as a plain string, and the installers only
 * update in place while their app id and NSIS mode stay what the installed copies have.
 */
const ROOT = join(__dirname, '..');
const DESKTOP = join(ROOT, 'applications', 'app-kit', 'desktop');
const read = (...p: string[]) => readFileSync(join(...p), 'utf-8');
const require = createRequire(import.meta.url);
const updater = require(join(DESKTOP, 'desktopUpdater.js'));
const MAIN = read(DESKTOP, 'main.js');
const PRELOAD = read(DESKTOP, 'preload.js');
const BRIDGE = read(ROOT, 'applications', 'app-kit', 'src', 'platform', 'desktopUpdater.ts');
const PKG = JSON.parse(read(DESKTOP, 'package.json'));

/** renderer -> main, and the bridge method that sends each. */
const INVOKED: Record<string, string> = {
  'updater:get-state': 'getState',
  'updater:check': 'check',
  'updater:install': 'install',
  'updater:open-release': 'openRelease',
};

function fakeIpc() {
  const handlers = new Map<string, (...args: any[]) => any>();
  return { handlers, ipcMain: { handle: (ch: string, fn: (...args: any[]) => any) => { handlers.set(ch, fn); } } };
}

function fakeWindows() {
  const sent: any[] = [];
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (ch: string, state: any) => sent.push([ch, state]) } };
  return { sent, BrowserWindow: { getAllWindows: () => [win] } };
}

class FakeUpdater extends EventEmitter {
  autoDownload = true; autoInstallOnAppQuit = true; allowPrerelease = true; fullChangelog = true; allowDowngrade = true;
  disableWebInstaller = false;
  forceDevUpdateConfig = false; logger: any = null; feed: any = null;
  next: () => void = () => {};
  installed: any[] = [];
  setFeedURL(feed: any) { this.feed = feed; }
  async checkForUpdates() { this.next(); return null; }
  quitAndInstall(...args: any[]) { this.installed.push(args); }
}

function setup(opts: { isPackaged?: boolean; platform?: string; env?: Record<string, string> } = {}) {
  const { ipcMain, handlers } = fakeIpc();
  const { BrowserWindow, sent } = fakeWindows();
  const fake = new FakeUpdater();
  const order: string[] = [];
  const timeouts: (() => void)[] = [];
  const opened: string[] = [];
  const handle = updater.registerIpc({
    ipcMain, BrowserWindow,
    app: { isPackaged: opts.isPackaged ?? true, getVersion: () => '1.2.4' },
    shell: { openExternal: async (url: string) => { opened.push(url); } },
    standDownUnloadGuards: () => order.push('stand-down'),
    createUpdater: () => fake,
    env: opts.env ?? {}, platform: opts.platform ?? 'win32',
    timers: { setTimeout: (fn: () => void) => { timeouts.push(fn); return 0; }, setInterval: () => 0 },
    log: { log() {}, warn() {}, error() {} },
  });
  fake.quitAndInstall = (...args: any[]) => { order.push('quit-and-install'); fake.installed.push(args); };
  return { handle, handlers, sent, fake, order, timeouts, opened };
}

describe('desktop updater: the IPC seams agree', () => {
  it('main registers it, the preload sends what it handles, the bridge checks every method', () => {
    expect(MAIN).toMatch(/require\('\.\/desktopUpdater'\)/);
    expect(MAIN).toMatch(/desktopUpdater\.registerIpc\(/);
    expect(MAIN).toMatch(/updater\.start\(\)/);
    const { handlers } = setup();
    for (const [channel, method] of Object.entries(INVOKED)) {
      expect(handlers.has(channel), channel).toBe(true);
      expect(PRELOAD).toMatch(new RegExp(`${method}: \\(\\) => ipcRenderer\\.invoke\\('${channel}'\\)`));
      expect(BRIDGE).toContain(`'${method}'`);
    }
    expect(updater.CHANNELS.state).toBe('updater:state-changed');
    expect(PRELOAD).toContain(`ipcRenderer.on('${updater.CHANNELS.state}'`);
    expect(PRELOAD).toContain(`ipcRenderer.removeListener('${updater.CHANNELS.state}'`);
    expect(BRIDGE).toContain(`'onState'`);
  });

  it('main stands every window\'s unload guard down for the install', () => {
    expect(MAIN).toMatch(/standDownUnloadGuards: \(\) => \{[\s\S]*?clearedToUnload\.add\(w\.webContents\.id\)/);
  });
});

describe('desktop updater: when it runs', () => {
  it('a packaged Windows or AppImage build installs; a Mac only announces', () => {
    expect(updater.updateMode({ isPackaged: true, platform: 'win32', env: {} })).toBe('auto');
    expect(updater.updateMode({ isPackaged: true, platform: 'linux', env: { APPIMAGE: '/x.AppImage' } })).toBe('auto');
    expect(updater.updateMode({ isPackaged: true, platform: 'darwin', env: {} })).toBe('manual');
  });

  it('off for a dev build without a test feed, a Linux build that is not an AppImage, and CLEO_UPDATES=0', () => {
    expect(updater.updateMode({ isPackaged: false, platform: 'win32', env: {} })).toBe('off');
    expect(updater.updateMode({ isPackaged: false, platform: 'win32', env: { CLEO_UPDATE_FEED: 'http://127.0.0.1:8765' } })).toBe('auto');
    expect(updater.updateMode({ isPackaged: true, platform: 'linux', env: {} })).toBe('off');
    expect(updater.updateMode({ isPackaged: true, platform: 'win32', env: { CLEO_UPDATES: '0' } })).toBe('off');
  });

  it('the test feed is https, or http to this machine only', () => {
    expect(updater.feedOverride({ CLEO_UPDATE_FEED: 'http://127.0.0.1:8765' })).toBe('http://127.0.0.1:8765/');
    expect(updater.feedOverride({ CLEO_UPDATE_FEED: 'http://localhost:8765/feed/' })).toBe('http://localhost:8765/feed/');
    expect(updater.feedOverride({ CLEO_UPDATE_FEED: 'https://updates.example.com/cleo' })).toBe('https://updates.example.com/cleo/');
    expect(updater.feedOverride({ CLEO_UPDATE_FEED: 'http://updates.example.com/' })).toBeNull();
    expect(updater.feedOverride({ CLEO_UPDATE_FEED: 'file:///c:/x' })).toBeNull();
    expect(updater.feedOverride({ CLEO_UPDATE_FEED: 'not a url' })).toBeNull();
    expect(updater.feedOverride({})).toBeNull();
  });

  it('a disabled build never creates an updater and reports disabled', async () => {
    const created = vi.fn();
    const { ipcMain, handlers } = fakeIpc();
    const { BrowserWindow } = fakeWindows();
    updater.registerIpc({
      ipcMain, BrowserWindow, app: { isPackaged: false, getVersion: () => '1.2.4' }, shell: {},
      createUpdater: created, env: {}, platform: 'win32', log: console,
    });
    expect(created).not.toHaveBeenCalled();
    expect(await handlers.get('updater:get-state')!()).toMatchObject({ status: 'disabled', current: '1.2.4' });
    expect(await handlers.get('updater:install')!()).toMatchObject({ ok: false });
  });
});

describe('desktop updater: electron-updater is set up to read the 4-part tags', () => {
  it('no prereleases, no full changelog, no downgrades (those paths parse the tag as semver)', () => {
    const { fake } = setup();
    expect(fake.allowPrerelease).toBe(false);
    expect(fake.fullChangelog).toBe(false);
    expect(fake.allowDowngrade).toBe(false);
    expect(fake.autoDownload).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(true);
    expect(fake.disableWebInstaller).toBe(true);
    expect(fake.feed).toBeNull();
  });

  it('a Mac checks without downloading', () => {
    const { fake } = setup({ platform: 'darwin' });
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(false);
  });

  it('the test feed replaces GitHub, and a dev build reads its dev config for it', () => {
    const { fake } = setup({ isPackaged: false, env: { CLEO_UPDATE_FEED: 'http://127.0.0.1:8765' } });
    expect(fake.feed).toEqual({ provider: 'generic', url: 'http://127.0.0.1:8765/' });
    expect(fake.forceDevUpdateConfig).toBe(true);
    // Downloads to test the flow, but never installs on quit: that would run the test feed's file.
    expect(fake.autoDownload).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(false);
  });

  it('a release page is the tag of the product version: package 1.2.5 is v1.1.2.5', () => {
    expect(updater.productVersion('1.2.5')).toBe('1.1.2.5');
    expect(updater.releasePageUrl('1.2.5')).toBe('https://github.com/arielriveros/cleo/releases/tag/v1.1.2.5');
    expect(updater.releasePageUrl(null)).toBe('https://github.com/arielriveros/cleo/releases/latest');
    // The same prefix the editor's version label adds (buildVersion.js) and bump-version.mjs writes.
    expect(read(ROOT, 'applications', 'editor', 'buildVersion.js')).toContain(`"${updater.PRODUCT_PREFIX}" + require("../../package.json").version`);
    expect(BRIDGE).toContain('return `1.${version}`');
  });

  it('notes come as markdown whether electron-updater gives a string or a list', () => {
    expect(updater.notesOf('  hello  ')).toBe('hello');
    expect(updater.notesOf([{ version: '1.2.5', note: 'a' }, { version: '1.2.4', note: null }])).toBe('### v1.1.2.5\n\na\n\n### v1.1.2.4');
    expect(updater.notesOf(null)).toBe('');
  });
});

describe('desktop updater: states', () => {
  const base = updater.initialState({ mode: 'auto', current: '1.2.4' });
  const R = (s: any, ...events: any[]) => events.reduce(updater.reduce, s);

  it('found, downloading, ready', () => {
    const s = R(base, { type: 'checking' }, { type: 'available', info: { version: '1.2.5', releaseNotes: 'notes' } },
      { type: 'progress', percent: 42.5 }, { type: 'downloaded', info: { version: '1.2.5' } });
    expect(s).toMatchObject({ status: 'ready', version: '1.2.5', notes: 'notes', percent: 100,
      releaseUrl: 'https://github.com/arielriveros/cleo/releases/tag/v1.1.2.5' });
  });

  it('a background failure (offline, or a release whose latest.yml is not attached yet) goes back to idle', () => {
    expect(R(base, { type: 'checking' }, { type: 'error', message: '404' })).toMatchObject({ status: 'idle', error: undefined });
  });

  it('a check someone asked for, or a download under way, reports its failure', () => {
    expect(R(base, { type: 'checking', user: true }, { type: 'error', message: 'offline' })).toMatchObject({ status: 'error', error: 'offline' });
    const downloading = R(base, { type: 'available', info: { version: '1.2.5' } });
    expect(downloading.status).toBe('downloading');
    expect(R(downloading, { type: 'error', message: 'sha512 mismatch' })).toMatchObject({ status: 'error', version: '1.2.5' });
  });

  it('a download under way keeps its progress through a later check', () => {
    const downloading = R(base, { type: 'available', info: { version: '1.2.5' } }, { type: 'progress', percent: 10 });
    expect(R(downloading, { type: 'checking' })).toBe(downloading);
  });

  it('a ready update stays ready whatever later checks say', () => {
    const ready = R(base, { type: 'available', info: { version: '1.2.5' } }, { type: 'downloaded', info: {} });
    expect(ready.status).toBe('ready');
    expect(R(ready, { type: 'checking' }, { type: 'not-available' }, { type: 'error', message: 'x' })).toBe(ready);
  });

  it('a Mac announces, and a failed later check keeps the announcement', () => {
    const mac = updater.initialState({ mode: 'manual', current: '1.2.4' });
    const announced = R(mac, { type: 'available', info: { version: '1.2.5' } });
    expect(announced).toMatchObject({ status: 'available', manual: true, percent: undefined });
    // The button stays while the next check runs, and after it fails in the background.
    expect(R(announced, { type: 'checking' }).status).toBe('available');
    expect(R(announced, { type: 'checking' }, { type: 'error', message: 'x' })).toMatchObject({ status: 'available', version: '1.2.5' });
    // One someone asked for still says it failed.
    expect(R(announced, { type: 'checking', user: true }, { type: 'error', message: 'x' }).status).toBe('error');
  });

  it('disabled stays disabled', () => {
    const off = updater.initialState({ mode: 'off', current: '1.2.4' });
    expect(R(off, { type: 'available', info: { version: '9' } })).toBe(off);
  });
});

describe('desktop updater: checking and installing', () => {
  it('every change is pushed to the windows', async () => {
    const { handlers, sent, fake } = setup();
    fake.next = () => fake.emit('update-available', { version: '1.2.5', releaseNotes: 'n' });
    const state = await handlers.get('updater:check')!();
    expect(state).toMatchObject({ status: 'downloading', version: '1.2.5' });
    expect(sent.map(([ch, s]) => [ch, s.status])).toEqual([['updater:state-changed', 'checking'], ['updater:state-changed', 'downloading']]);
  });

  it('up to date', async () => {
    const { handlers, fake } = setup();
    fake.next = () => fake.emit('update-not-available', {});
    expect(await handlers.get('updater:check')!()).toMatchObject({ status: 'idle' });
  });

  it('a manual check that fails says so', async () => {
    const { handlers, fake } = setup();
    fake.checkForUpdates = async () => { fake.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED')); throw new Error('net::ERR_INTERNET_DISCONNECTED'); };
    expect(await handlers.get('updater:check')!()).toMatchObject({ status: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' });
  });

  it('the background check after launch says nothing when it fails', async () => {
    const { handle, timeouts, fake } = setup();
    fake.checkForUpdates = async () => { fake.emit('error', new Error('HttpError: 404')); throw new Error('HttpError: 404'); };
    handle.start();
    expect(timeouts).toHaveLength(1);
    timeouts[0]();
    await new Promise(r => setTimeout(r, 0));
    expect(handle.state().status).toBe('idle');
  });

  it('install is refused until an update is ready', async () => {
    const { handlers, order } = setup();
    expect(await handlers.get('updater:install')!()).toMatchObject({ ok: false });
    expect(order).toEqual([]);
  });

  it('install stands the unload guards down, then quits and installs silently and relaunches', async () => {
    const { handlers, fake, order, timeouts } = setup();
    fake.emit('update-available', { version: '1.2.5' });
    fake.emit('update-downloaded', { version: '1.2.5' });
    expect(await handlers.get('updater:install')!()).toEqual({ ok: true });
    expect(order).toEqual(['stand-down']);
    timeouts.forEach(fn => fn());
    expect(order).toEqual(['stand-down', 'quit-and-install']);
    expect(fake.installed).toEqual([[true, true]]);
  });

  it('a Mac never installs, and opens the release page instead', async () => {
    const { handlers, fake, opened } = setup({ platform: 'darwin' });
    fake.emit('update-available', { version: '1.2.5' });
    expect(await handlers.get('updater:install')!()).toMatchObject({ ok: false });
    expect(await handlers.get('updater:open-release')!()).toBe(true);
    expect(opened).toEqual(['https://github.com/arielriveros/cleo/releases/tag/v1.1.2.5']);
  });

  it('a dev build with a test feed checks, and never installs', async () => {
    const { handlers, fake } = setup({ isPackaged: false, env: { CLEO_UPDATE_FEED: 'http://127.0.0.1:8765' } });
    fake.emit('update-available', { version: '9.9.9' });
    fake.emit('update-downloaded', { version: '9.9.9' });
    expect(await handlers.get('updater:install')!()).toMatchObject({ ok: false });
  });
});

describe('desktop updater: what the installers must keep', () => {
  const build = PKG.build;

  it('publishes to this repository on GitHub, which writes latest.yml and app-update.yml', () => {
    expect(build.publish).toEqual([{ provider: 'github', owner: updater.REPO.owner, repo: updater.REPO.repo }]);
    expect(PKG.scripts.dist).toContain('--publish never');
  });

  it('the installed copies\' identity is unchanged, so an update installs over them', () => {
    expect(build.appId).toBe('com.cleo.editor');
    expect(build.productName).toBe('Cleo Editor');
    expect(PKG.name).toBe('cleo-desktop');
    expect(build.nsis).toMatchObject({ oneClick: true, perMachine: false });
  });

  it('artifact names have no spaces (GitHub renames them, and latest.yml would point at nothing)', () => {
    for (const target of ['nsis', 'dmg', 'appImage']) {
      expect(build[target]?.artifactName, target).toBeTruthy();
      expect(build[target].artifactName, target).not.toMatch(/\s/);
    }
  });

  it('ships the updater and electron-builder, both as dependencies, unpacked', () => {
    expect(build.files).toContain('desktopUpdater.js');
    expect(PKG.dependencies['electron-updater']).toBeTruthy();
    // Publishing a game's installer runs electron-builder inside the packaged editor.
    expect(PKG.dependencies['electron-builder']).toBeTruthy();
    expect(PKG.devDependencies['electron-builder']).toBeUndefined();
    expect(PKG.scripts.dist).toContain('ALLOW_ELECTRON_BUILDER_AS_PRODUCTION_DEPENDENCY=true');
    expect(build.asarUnpack).toContain('node_modules/**');
    expect(MAIN).toMatch(/app\.asar\.unpacked', 'node_modules', 'electron-builder'/);
    // electron is a devDependency, absent from the packaged app: the running shell's version is used instead.
    expect(MAIN).not.toMatch(/require\('electron\/package\.json'\)/);
  });

  it('the explicit file list holds on every platform, and each ships only its own builder binaries', () => {
    // A platform-level `files` REPLACES the top-level list, and one of exclusions only becomes `**/*`: the
    // installer then carried dev.js, tools/ and dev-app-update.yml. The per-OS trim is a `${os}` pattern instead.
    for (const os of ['win', 'mac', 'linux']) expect(build[os].files, os).toBeUndefined();
    expect(build.files).toContain('!node_modules/app-builder-bin/!(${os})/**');
    expect(build.files).toContain('!node_modules/7zip-bin/!(${os})/**');
  });

  it('the dev feed config never ships', () => {
    expect(build.files).not.toContain('dev-app-update.yml');
    expect(read(DESKTOP, 'dev-app-update.yml')).toMatch(/updaterCacheDirName:/);
  });
});
