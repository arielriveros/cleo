// The editor updating itself from GitHub Releases (electron-updater).
//
// Every release (release.yml) attaches the installers with their `latest.yml` / `latest-mac.yml` /
// `latest-linux.yml` and block maps, and only then is marked the repository's latest release. This module checks
// that release a little after launch and every few hours, downloads a newer one in the background on Windows and
// Linux, and tells every window (`updater:state-changed`): the menu bar's Update button (app-kit
// ui/UpdateButton.tsx) shows itself once there is something to say.
//
// macOS builds are not signed, and Squirrel.Mac installs nothing unsigned: there an update is only announced, and
// the button opens its release page.
//
// Why the GitHub provider and not a plain URL: it reads the latest release's TAG (`v1.1.2.5`) as a string and
// pins every download to it, so a release landing mid-download cannot swap the file under it, and the block map of
// the installed version is found beside its own installer for a differential download. The version compared is
// latest.yml's (`1.2.5`, package.json's x.y.z, same as app.getVersion()); the tag only adds the product line's
// leading `1.` (tools/bump-version.mjs). That works only while `allowPrerelease` and `fullChangelog` stay off:
// those paths read the tag as semver, which `v1.1.2.5` is not.
//
// Installing is a restart. The editor saves and lets go of its project first (features/updates/restartToUpdate.ts),
// then asks for `updater:install`; the unload guards stand down, because electron-updater starts the installer
// before it quits the app, and a quit a guard held up would be ended by the installer instead.
//
// Nothing here requires `electron` or `electron-updater` at load, so the tests drive it with fakes.

/** renderer -> main (invoke), and main -> renderer (send). */
const CHANNELS = {
  getState: 'updater:get-state',
  check: 'updater:check',
  install: 'updater:install',
  openRelease: 'updater:open-release',
  state: 'updater:state-changed',
};

/** Where releases are published (release.yml runs in this repository). */
const REPO = { owner: 'arielriveros', repo: 'cleo' };

/** package.json holds x.y.z; the product version and the release tags are `1.x.y.z` (tools/bump-version.mjs). */
const PRODUCT_PREFIX = '1.';

/** First check this long after launch: the editor is busy opening a project before that. */
const STARTUP_DELAY_MS = 30_000;
/** Then every this often, for an editor left open for days. */
const CHECK_INTERVAL_MS = 4 * 3600_000;

/** The product version of a package version: `1.2.5` -> `1.1.2.5`. */
function productVersion(version) {
  return PRODUCT_PREFIX + String(version);
}

/** A release's page on GitHub, or the latest release's when the version is unknown. */
function releasePageUrl(version) {
  const base = `https://github.com/${REPO.owner}/${REPO.repo}/releases`;
  return version ? `${base}/tag/v${productVersion(version)}` : `${base}/latest`;
}

/** Whether a URL is one of this repository's release pages (the only thing `openRelease` opens). */
function isReleaseUrl(url) {
  return typeof url === 'string' && url.startsWith(`https://github.com/${REPO.owner}/${REPO.repo}/releases/`);
}

/** electron-updater's `releaseNotes` (a string, or one note per version with fullChangelog) as markdown. */
function notesOf(releaseNotes) {
  if (typeof releaseNotes === 'string') return releaseNotes.trim();
  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map(n => [n && n.version ? `### v${productVersion(n.version)}` : '', n && typeof n.note === 'string' ? n.note.trim() : '']
        .filter(Boolean).join('\n\n'))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

/**
 * The feed `CLEO_UPDATE_FEED` points the updater at instead of GitHub: a folder holding a latest.yml and its
 * installer. For testing an update without publishing a release, and as a way out if GitHub's feed ever breaks.
 * Only https, or http to this machine.
 */
function feedOverride(env) {
  const raw = env && typeof env.CLEO_UPDATE_FEED === 'string' ? env.CLEO_UPDATE_FEED.trim() : '';
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

/**
 * How this build updates: 'auto' downloads and installs, 'manual' only announces (the release page has the
 * download), 'off' does nothing. Off for a dev build unless a test feed is set, and for a Linux build that is not
 * an AppImage, which electron-updater cannot replace.
 */
function updateMode({ isPackaged, env = {}, platform }) {
  if (env.CLEO_UPDATES === '0') return 'off';
  const override = feedOverride(env);
  if (!isPackaged && !override) return 'off';
  if (platform === 'darwin') return 'manual';
  if (platform === 'linux' && !env.APPIMAGE) return 'off';
  return 'auto';
}

/** What a window is told before anything happened. */
function initialState({ mode, current, dev = false }) {
  return { status: mode === 'off' ? 'disabled' : 'idle', current, manual: mode === 'manual', dev };
}

/**
 * The next state, for one updater event. Pure. `userCheck` marks a check someone asked for (Help ▸ Check for
 * Updates…): only that one, or a download that was under way, surfaces an error. A background check that fails
 * -- offline, or a release whose installers are not attached yet (its latest.yml is a 404) -- goes back to idle,
 * so the button never shows an error nobody asked about. A downloaded update stays ready whatever later checks say.
 */
function reduce(state, event) {
  if (state.status === 'disabled') return state;
  const ready = state.status === 'ready';
  switch (event.type) {
    case 'checking':
      // A download under way keeps showing its progress; electron-updater does not start a second one.
      if (ready || state.status === 'downloading') return state;
      // An announced update (a Mac) stays on the bar while the next check runs.
      if (state.status === 'available') return { ...state, userCheck: !!event.user };
      return { ...state, status: 'checking', userCheck: !!event.user, error: undefined };
    case 'available': {
      if (ready) return state;
      const info = event.info || {};
      return {
        ...state,
        status: state.manual ? 'available' : 'downloading',
        version: info.version, notes: notesOf(info.releaseNotes), releaseDate: info.releaseDate,
        releaseUrl: releasePageUrl(info.version), percent: state.manual ? undefined : 0, error: undefined,
        checkedAt: event.at,
      };
    }
    case 'progress':
      if (state.status !== 'downloading' && state.status !== 'available') return state;
      return { ...state, status: 'downloading', percent: Math.max(0, Math.min(100, Number(event.percent) || 0)) };
    case 'downloaded': {
      const info = event.info || {};
      const version = info.version || state.version;
      return {
        ...state, status: 'ready', version,
        notes: notesOf(info.releaseNotes) || state.notes, releaseDate: info.releaseDate || state.releaseDate,
        releaseUrl: releasePageUrl(version), percent: 100, error: undefined, userCheck: false,
      };
    }
    case 'not-available':
      if (ready) return state;
      return {
        ...state, status: 'idle', version: undefined, notes: undefined, releaseDate: undefined,
        releaseUrl: undefined, percent: undefined, error: undefined, checkedAt: event.at,
      };
    case 'error': {
      if (ready) return state;
      const shown = state.userCheck || state.status === 'downloading';
      if (shown) {
        return { ...state, status: 'error', error: String(event.message || 'The update failed.'), userCheck: false };
      }
      // Announced on a Mac and the next check failed: what was announced still holds.
      if (state.status === 'available') return { ...state, userCheck: false };
      return { ...state, status: 'idle', error: undefined, userCheck: false };
    }
    default:
      return state;
  }
}

/**
 * Wire the updater to IPC and start checking. `standDownUnloadGuards` lets every window's next unload through (the
 * shell's `clearedToUnload`): the editor has already saved by the time it asks to install. Returns a handle for
 * the tests: the current state and a check.
 */
function registerIpc({
  ipcMain, BrowserWindow, app, shell, standDownUnloadGuards = () => {},
  createUpdater = () => require('electron-updater').autoUpdater,
  env = process.env, platform = process.platform, timers = globalThis, log = console,
}) {
  const mode = updateMode({ isPackaged: app.isPackaged, env, platform });
  let state = initialState({ mode, current: app.getVersion(), dev: !app.isPackaged });
  let updater = null;
  let started = false;

  const broadcast = () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHANNELS.state, state);
    }
  };
  const dispatch = (event) => {
    const next = reduce(state, event);
    if (next !== state) { state = next; broadcast(); }
  };

  if (mode !== 'off') {
    updater = createUpdater();
    updater.logger = {
      info: (m) => log.log('[updater]', m),
      warn: (m) => log.warn('[updater]', m),
      error: (m) => log.error('[updater]', m),
      debug: () => {},
    };
    updater.autoDownload = mode === 'auto';
    // Never from a dev build: quitting one with a test feed's download waiting would run that installer.
    updater.autoInstallOnAppQuit = mode === 'auto' && app.isPackaged;
    // The installers are whole (NSIS, not the web installer's stub that downloads the app on install).
    updater.disableWebInstaller = true;
    // See the header: the 4-part tag is read as a string only while these stay off.
    updater.allowPrerelease = false;
    updater.fullChangelog = false;
    updater.allowDowngrade = false;
    const override = feedOverride(env);
    if (override) {
      updater.setFeedURL({ provider: 'generic', url: override });
      // A dev build reads dev-app-update.yml for its cache folder; without this it would not check at all.
      if (!app.isPackaged) updater.forceDevUpdateConfig = true;
    }
    updater.on('update-available', (info) => dispatch({ type: 'available', info, at: Date.now() }));
    updater.on('update-not-available', () => dispatch({ type: 'not-available', at: Date.now() }));
    updater.on('download-progress', (p) => dispatch({ type: 'progress', percent: p && p.percent }));
    updater.on('update-downloaded', (info) => dispatch({ type: 'downloaded', info }));
    updater.on('error', (e) => {
      log.warn('[updater]', e && e.message ? e.message : e);
      dispatch({ type: 'error', message: e && e.message ? e.message : String(e) });
    });
  }

  /** One check; resolves with the state it left. A user's check is the only kind that reports failure. */
  const check = async (user = false) => {
    if (!updater) return state;
    // Nothing to learn while a check runs, a download is under way, or an update waits for its restart.
    if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return state;
    dispatch({ type: 'checking', user });
    try {
      await updater.checkForUpdates();
    } catch (e) {
      // Usually also emitted as 'error'; dispatching twice is harmless (the first one already left 'checking').
      if (state.status === 'checking') dispatch({ type: 'error', message: e && e.message ? e.message : String(e) });
    }
    return state;
  };

  ipcMain.handle(CHANNELS.getState, () => state);
  ipcMain.handle(CHANNELS.check, () => check(true));
  ipcMain.handle(CHANNELS.install, () => {
    if (!updater || state.status !== 'ready') return { ok: false, error: 'No update is ready to install.' };
    if (mode !== 'auto' || !app.isPackaged) return { ok: false, error: 'This build cannot install updates itself.' };
    standDownUnloadGuards();
    // After the reply has gone back: the renderer is waiting on it.
    timers.setTimeout(() => updater.quitAndInstall(true, true), 0);
    return { ok: true };
  });
  ipcMain.handle(CHANNELS.openRelease, () => {
    const url = state.releaseUrl || releasePageUrl(null);
    if (!isReleaseUrl(url)) return false;
    void shell.openExternal(url);
    return true;
  });

  /** Begin the checks (after app ready). */
  const start = () => {
    if (!updater || started) return;
    started = true;
    timers.setTimeout(() => { void check(false); }, STARTUP_DELAY_MS);
    timers.setInterval(() => { void check(false); }, CHECK_INTERVAL_MS);
  };

  return { mode, state: () => state, check, start };
}

module.exports = {
  CHANNELS, REPO, PRODUCT_PREFIX, STARTUP_DELAY_MS, CHECK_INTERVAL_MS,
  productVersion, releasePageUrl, isReleaseUrl, notesOf, feedOverride, updateMode, initialState, reduce, registerIpc,
};
