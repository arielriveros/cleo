# Cleo Desktop

Electron shell that runs the Cleo engine + editor as a native desktop app, and adds a **Publish**
feature for exporting optimized, standalone games.

## Develop

From the repo root:

```
npm run desktop:dev
```

This runs the engine type watcher, the editor dev server (port 8080) and Electron pointed at it. Only the
Electron window opens; the dev server does not launch a browser (`npm run editor:dev` is the browser
flavour). (Requires `npm install` in the root, `editor/`, and `desktop/`.)

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

- **Web (HTML)** — writes four files: `index.html` (CSS embedded),
  `game.js` (engine + runtime), `game.scripts.js` (your node scripts), and `game.bin` (all game
  data — scenes, meshes and textures — packed into one binary). Serve the folder over HTTP to play.
  In a plain browser (no desktop app) this downloads a `.zip` of the same files instead.
- **Desktop (Electron)** — scaffolds a runnable Electron game folder (the web files plus `main.js`,
  `preload.js`, `package.json`). `cd` in, then `npm install && npm start`.
- **Desktop installer** — saves only the native installer (e.g. `<Game> Setup 1.0.0.exe`), built by
  electron-builder from a temporary copy of the runnable folder.
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
editor itself (`desktop/dist/`).
