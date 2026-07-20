# Cleo Desktop

Electron shell that runs the Cleo engine + editor as a native desktop app, and adds a **Publish**
feature for exporting optimized, standalone games.

## Develop

From the repo root:

```
npm run desktop:dev
```

This runs the engine watcher, the editor dev server (port 8080), and Electron pointed at it.
(Requires `npm install` in the root, `editor/`, and `desktop/`.)

To run against a prebuilt editor instead of the dev server:

```
npm run build          # engine -> dist/
npm --prefix editor run build
npm --prefix editor run build:player
npm --prefix desktop start
```

## Publish

In the editor toolbar, use **Publish**:

- **Web (HTML)** — writes four files to a folder you choose: `index.html` (CSS embedded),
  `game.js` (engine + runtime), `game.scripts.js` (your node scripts), and `game.bin` (all game
  data — scenes, meshes and textures — packed into one binary). Serve the folder over HTTP to play.
  In a plain browser (no desktop app) this downloads a `.zip` of the same files instead.
- **Desktop (Electron)** — scaffolds a runnable Electron game folder (the web files plus `main.js`,
  `preload.js`, `package.json`). `cd` in, then `npm install && npm start`.
- **Desktop installer** — additionally packages a native installer via electron-builder
  (needs network access to download Electron).

The published game reuses the prebuilt player bundle in `editor/public/player/`, so run
`npm --prefix editor run build:player` before publishing.

## Package the editor app

```
npm run desktop:build
```

Builds the engine, editor, and player, then runs electron-builder to produce an installer for the
editor itself (`desktop/dist/`).
