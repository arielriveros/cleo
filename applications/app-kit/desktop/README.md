# Cleo Desktop

Electron shell that runs the Cleo engine + editor as a native desktop app, and adds a **Publish**
feature for exporting optimized, standalone games.

It lives in the app-kit (`applications/app-kit/desktop`) as a standalone npm project with its own
lockfile, outside the `applications/` workspace: electron-builder needs electron in a local
`node_modules`. It hosts the Editor, the only app that ships on desktop for now; everything
app-specific is the `HOSTED_APP` block at the top of `main.js` (plus `extraResources` in
`package.json`).

`icons/` holds the window, executable and installer icons: the colour logo, and the black-and-white one
for Creator windows. They are made from the masters in `app-kit/src/assets/logo` by
`npm run brand:icons` (`tools/brandIcons.mjs`), along with each app's favicons and loading-screen logo.

## Develop

From the repo root:

```
npm run desktop:dev
```

This runs the engine type watcher, the editor dev server (port 8080) and Electron pointed at it. Only the
Electron window opens; the dev server does not launch a browser (`npm run editor:dev` is the browser
flavour). Closing the window stops the rest. (Requires `npm install` at the root and `npm ci` in
`applications/`. The shell's own dependencies are installed on the first run — `tools/ensureDesktop.mjs`,
the same install as `npm run desktop:install`.)

The Creator is not started: its menu-bar button opens a page saying so. Run `npm run creator:serve`
alongside to use it — the editor's dev server proxies `/creator/` to it.

Electron is launched through `dev.js`, which removes `ELECTRON_RUN_AS_NODE` from its environment. VS Code
sets that variable for processes its extensions spawn, and with it Electron starts as plain Node and no
window opens.

No engine build is needed first. The editor compiles engine **source** directly through the `cleo` alias
(vite.config.ts), so engine edits hot-reload like editor edits. `dist/` only carries declarations for the
script editor's types; `watch:types` (tools/watchTypes.mjs) creates it when missing, prunes declarations
whose source is gone, and keeps it current. The game player bundle that Publish uses is rebuilt at startup
only when it is missing or older than the engine source (tools/ensurePlayer.mjs).

To run against a prebuilt editor instead of the dev server:

```
npm run build          # engine -> dist/
npm --prefix editor run build
npm --prefix editor run build:player
npm --prefix desktop start
```

## Publish

In the editor toolbar, use **Publish**:

Each build is saved in a folder named after the game (Options ▸ Project ▸ Published game ▸ Title,
else the project name) inside the location you pick.

- **Web (HTML)** — writes `index.html` (CSS embedded), the player (`game.js`, `physics-worker.js` and a
  `chunks/` folder: the engine and runtime as ES modules), `game.scripts.js` (your node scripts), and
  `game.bin` (all game data — scenes, meshes and textures — packed into one binary). Serve the folder
  over HTTP to play; opened straight from disk, the page says so. In a plain browser (no desktop app)
  this downloads a `.zip` of the same files instead.
- **Desktop (Electron)** — scaffolds a runnable Electron game folder (the web files plus `main.js`,
  `preload.js`, `package.json`). `cd` in, then `npm install && npm start`.
- **Desktop installer** — saves the native installer (e.g. `<Game> Setup 1.0.0.exe`, its version from
  Options ▸ Project ▸ Published game ▸ Version) and its update files (`latest.yml`, the `.blockmap`), built by
  electron-builder from a temporary copy of the runnable folder, under the project's app id and with its icon.
  On Windows it is a wizard: the player picks the install folder and whether to create desktop and
  Start Menu shortcuts (`GAME_INSTALLER_NSH` in `gameTemplates.js`)
  (needs network access to download Electron).

The published game reuses the prebuilt player bundle in `applications/editor/public/player/`, so run
`npm --prefix editor run build:player` before publishing.

## Package the editor app

```
npm run desktop:build
```

Builds the engine, editor, and player, then runs electron-builder to produce an installer for the
editor itself (`applications/app-kit/desktop/dist/`).

`electron-builder` is a dependency of the shell, not only a build tool: the editor runs it to package a game's
installer. So `npm run dist` sets `ALLOW_ELECTRON_BUILDER_AS_PRODUCTION_DEPENDENCY`, and the packaged app keeps its
`node_modules` unpacked beside `app.asar` (`asarUnpack`), because the game's build runs with `process.noAsar` set and
can read nothing inside the archive. Each platform ships only its own `app-builder-bin` and `7zip-bin` binaries.

## Updates

A packaged editor updates itself from this repository's GitHub Releases (`desktopUpdater.js`, electron-updater with
the `github` provider in `package.json`). A little after launch, and every four hours, it reads the latest release's
`latest.yml` (`latest-mac.yml`, `latest-linux.yml`); a newer version downloads in the background, and the Update
button at the right end of the menu bar offers to restart into it. Quitting installs it too. macOS builds are not
signed, which Squirrel.Mac requires, so there an update is only announced and the button opens its release page. A
Linux build updates only as an AppImage.

Every release attaches the installers, their `latest*.yml` and their `.blockmap` files (release.yml, `installers`
job), and is marked the latest release only after that, so an editor never finds a release it cannot download.
Installer names have no spaces (`Cleo-Editor-Setup-1.2.5.exe`): GitHub turns spaces in asset names into dots, which
the names inside `latest.yml` would no longer match.

Versions up to v1.1.2.4 have no updater: the first release with one is installed by hand, over the old one (same
`appId`, same one-click per-user NSIS installer). After that, each release reaches every desktop editor.

To try an update without publishing a release:

```
# build a "newer" installer and serve it (its notes come from build/release-notes.md, when present)
npx electron-builder --win --publish never -c.extraMetadata.version=9.9.9
npx http-server dist -p 8765
# then start an installed (older) editor with
CLEO_UPDATE_FEED=http://127.0.0.1:8765/
```

`CLEO_UPDATE_FEED` (https, or http to this machine) replaces GitHub as the feed; an unpackaged editor checks only
with it set, reads `dev-app-update.yml`, and never installs. `CLEO_UPDATES=0` turns checking off.

`npm run test:updates` (root; needs `npm run editor:build`) does the unpackaged half of that in the real app: a
local feed's update found, downloaded, shown on the Update button and refused, Help ▸ About's changelog, and a
project cover captured from a copy of the Sandbox (`tools/updatesE2E.mjs`).
