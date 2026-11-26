# Game updates — releasing a Cleo game and keeping its players current (plan)

Status: **phase 0 done** (identity: version, app id, icon; `game` in the manifest; installers keep their update
files) · next: **phase 1, desktop full updates** · Started 2026-11-21

A Cleo game is published as a web folder, a runnable desktop folder or a desktop installer (see
[Publishing](../editor/publishing.md)). This plan covers what comes after the first release: getting a newer
build to the players who have an older one, without losing their saves, on every target.

The editor solves the same problem for itself: the desktop editor updates from GitHub Releases through
electron-updater (`applications/app-kit/desktop/desktopUpdater.js`). Games reuse that machinery where they can,
but a game has needs the editor does not: content changes far more often than code, players may never see a
settings page, and stores (Steam, itch.io) bring updaters of their own.

---

## 1. Identity — what an update must agree with (done)

Options ▸ Project ▸ Published game, `ProjectIdentitySettings` in
`applications/editor/src/features/options/projectSettings.ts` (settings format 7).

| Field | What it is | Why it matters to updates |
|---|---|---|
| **Version** | Semver, `1.0.0` by default. | An update is a higher version. Written into the game's `package.json` (so electron-builder names the installer and writes `latest.yml` with it) and into `game.bin`. |
| **App id** | Reverse-DNS, `com.studio.game`. | Windows installs the game under it (the NSIS uninstaller key is derived from it), groups its taskbar button by it (`app.setAppUserModelId`), and an installer only upgrades an install with the same one. It must never change after the first release. |
| **Icon** | An image asset. | Not an update concern, but part of the same release identity: window, executable, installer, favicon (`features/publish/gameIcons.ts`). |

The app id used to be derived from the title (`com.cleo.game.` + its letters), so renaming a game made its next
installer a different app, installed beside the old one. Now a new project gets one of its own
(`newAppId`), and an older project keeps the derived one (`legacyAppId`), written into its settings at its next
publish so it can never move again. Opening a project never writes it: an untouched project (an example folder
in git) stays untouched.

**Not the save version.** `saves.version` is the shape of the game's saved data; it moves only when that shape
does, and `SaveGame.onMigrate` upgrades older saves (§6).

## 2. What a release is made of

| Target | Files a release ships | Update files |
|---|---|---|
| Web | `index.html`, the player (`game.js`, `chunks/`), `game.scripts.js`, `game.bin`, `_headers`, `icon.png`/`icon.ico` | none yet (§5) |
| Desktop installer, Windows | `<Game> Setup <version>.exe` | `latest.yml`, `<Game> Setup <version>.exe.blockmap` |
| Desktop installer, macOS | `<Game>-<version>.dmg` | `latest-mac.yml`, `.dmg.blockmap` |
| Desktop installer, Linux | `<Game>-<version>.AppImage` | `latest-linux.yml` (its block map is inside) |

Since phase 0 a desktop publish keeps the update files beside the installer (`isInstallerArtifact` in the
shell's `main.js`). electron-builder only writes them when the build has a publish provider, so the game's build
gets a placeholder (`https://updates.invalid/<appId>/`, a domain that never resolves) until phase 1 gives it a
real feed.

`game.bin`'s manifest carries `game: { name, version, appId }` (`PackManifest.game`, pack.ts). No player reads it
yet, which is why it did not need a contract bump; it is what a content patch is checked against (§4), and what a
launcher or a store page can read without unpacking anything else. Its `contentHash` (already used by NetSync's
join check) identifies the exact build.

**Open:** installer file names. electron-builder's default (`<Game> Setup 1.0.0.exe`) has spaces, which GitHub
turns into dots on upload, so the names inside `latest.yml` no longer match. The editor's own installers are
named without spaces for this reason (`Cleo-Editor-Setup-${version}.${ext}`); games should be too once they are
meant to be hosted on GitHub (`${appSlug}-Setup-${version}.${ext}`). Left for phase 1, because it changes the
file a user is used to seeing.

## 3. Desktop: full updates (phase 1)

A full update replaces the whole installed game: the Electron shell, the player and `game.bin`. Needed when the
player contract changes (`PLAYER_CONTRACT` in `playerContract.json`: a newer packer emits something the older
player cannot read), when the game's Electron version changes, and for the first update of a game published
before content patches existed.

**Mechanism: electron-updater in the game shell**, exactly as the editor uses it.

- `GAME_MAIN_JS` (`gameTemplates.js`) gains the updater: check at launch (after the first frame, never before),
  download in the background, install on quit, or on the game's say-so (below).
- The shell today ships no `node_modules` (`files: ['**/*', '!node_modules/**']`, `npmRebuild: false`).
  electron-updater has to be **bundled into one file** (esbuild, at editor build time, the same way the editor
  ships its other shell files) and written beside `main.js`, rather than installed into the game.
- **Feed**, from a new `identity.updates` block in project settings:
  - *None* (the default): no updater is written into the game at all.
  - *GitHub Releases*: owner and repo. Each release is tagged `v<version>` and carries the installers and their
    `latest*.yml`, as the editor's do. Use the `github` provider (it pins downloads to the tag).
  - *Static URL*: any HTTPS folder holding the newest installer and its `latest*.yml` (`generic` provider). Most
    hosts, an S3 bucket, a CDN.
- **Script API**, so the game decides how an update looks rather than a system dialog deciding for it:
  `Game.updates.state` (`none | checking | available | downloading | ready | error`), `Game.updates.version`,
  `Game.updates.notes`, `Game.updates.onChange(cb)`, `Game.updates.check()`, `Game.updates.restart()`. A game that
  ignores it gets the default: download silently, install when the player quits. It reaches the page through the
  game's preload, next to `cleoSaves`.
- **Release notes**: the Publish step writes a `release-notes.md` (from a Notes field on the publish, or the
  project's `CHANGELOG.md` section for its version) for electron-builder to put in `latest.yml`.

**Signing.** Windows: an unsigned installer updates fine (electron-updater checks a signature only when a
`publisherName` is set), but SmartScreen warns on the first install until the publisher has a reputation or a
certificate; a code-signing certificate in project-local settings, never in the project folder, is a later step.
macOS: Squirrel.Mac installs only signed and notarized builds, so an unsigned Mac game can only *announce* an
update (open the download page), as the unsigned editor does.

## 4. Desktop: content patches (phase 2)

Most game updates change content, not code: a level, a balance pass, new assets. A content patch is a new
`game.bin` (and `game.scripts.js`) for the same installed shell and player. Small to download, no installer, no
admin prompt, no restart of anything but the game.

- **Where it lives:** `<userData>/content/<version>/game.bin` (+ `game.scripts.js`, + its manifest's hash), beside
  the saves, outside the install folder.
- **Who serves it:** `gameProtocol.js` already serves `game.bin` a byte range at a time. It learns to prefer the
  newest installed patch when, and only when:
  1. its manifest's `game.appId` is this game's;
  2. its `contract` is at most the shipped player's (`PLAYER_CONTRACT` the player was built with); a patch that
     needs a newer player is a full update instead (§3);
  3. its sha512 (from the feed) and its manifest's `contentHash` both check out.
  Anything else, or any failure to read it, falls back to the `game.bin` the installer put there: a broken patch
  can never stop the game from starting.
- **Feed:** a `content.json` beside the installers: `{ version, contract, url, sha512, size, notes }`. The
  publish step writes it whenever it writes the installer.
- **Smaller still, later:** game.bin is a blob region addressed by offset and length. A patch could ship only
  the chunks whose bytes changed and the new manifest, assembled into a full `game.bin` locally, and checked with
  the same sha512. Worth doing once games are large; the whole-file patch comes first.

## 5. Web

A web game updates when its folder on the host is replaced; a player gets the new build on their next load. What
is missing is the running page knowing, and caches not serving a stale `game.bin`.

- **`version.json`** beside `index.html`: `{ version, contentHash }`. The page fetches it (no-cache) at start and
  every few minutes; a different `contentHash` raises `Game.updates` (`available`), and `Game.updates.restart()`
  reloads. Same script API as the desktop, so a game's update prompt works on both.
- **Cache busting:** `index.html` loads `game.bin?h=<contentHash>` and the player chunks by their hashed names
  (they already are). `_headers` gives `index.html` and `version.json` `Cache-Control: no-cache`, and the hashed
  files a long `max-age, immutable`.
- **Offline / installable (later):** a service worker can keep the last build for offline play and update it in
  the background. Not before there is a game that needs it.

## 6. Saves across updates

Already in place, and the reason updates can be routine:

- saves live outside the install folder (`<app data>/<saves folder>/saves` on the desktop, a storage namespace on
  the web), so neither an installer nor a patch touches them;
- every save records `saves.version`, and `SaveGame.onMigrate` upgrades older ones as they load;
- the save folder name is fixed at the first release (Options ▸ Project ▸ Saves ▸ Save folder).

To add: a save written by a **newer** version (`saves.version` greater than the running game's: a player who
rolled back, or a patch that failed and fell back) is refused with a clear message rather than loaded and
mangled.

## 7. Stores and other channels

| Channel | Who updates | What Cleo does |
|---|---|---|
| **GitHub Releases / static host** | The game's own updater (§3, §4). | Writes the feed files at publish. |
| **itch.io** | The itch app, from a channel pushed with butler. | A publish target that writes the folder butler pushes (`butler push <dir> <user>/<game>:<channel> --userversion <version>`). The game's own updater stays off when it runs under the itch app (it sets `ITCHIO_API_KEY`), and its feed is left out of an itch build. |
| **Steam** | Steam, from depots uploaded with SteamPipe. | A publish target that writes the depot folder. The game's own updater is never written into a Steam build (a Steam build is a separate publish, `identity.updates` forced to none). |
| **Web portals** | The portal hosts the folder. | Nothing beyond §5. |

Each is its own build of the same game: one game, several publish targets, each with its own idea of updates.

## 8. Security

- Feeds over HTTPS only (as the editor's updater: http only to this machine, for testing).
- Every download checked by sha512 from a feed fetched over HTTPS; a content patch also by its manifest's
  `contentHash` and app id.
- No arbitrary code from a patch beyond what `game.scripts.js` already is: a patch replaces the game's own
  scripts, from the game's own feed, which is the same trust as the installer.
- Staged rollouts (`stagingPercentage` in `latest.yml`) for games with many players, so a bad build reaches a
  few first.

## 9. Phases

| Phase | What | State |
|---|---|---|
| 0 | Identity (version, app id, icon), `game` in the manifest, update files kept beside the installer | done |
| 1 | Desktop full updates: `identity.updates` feed setting, bundled electron-updater in the game shell, `Game.updates`, release notes at publish, space-free installer names | next |
| 2 | Desktop content patches: `content.json`, patch store in userData, `gameProtocol.js` preference with fallback | |
| 3 | Web: `version.json`, `Game.updates` on the web, cache headers | |
| 4 | itch.io and Steam publish targets (updater off) | |
| 5 | Chunk-level content patches, staged rollouts, a refused-newer-save message | |

## 10. Open questions

- Should a publish also **upload** (GitHub Releases through a token, a static host through a configured command),
  or only write the files and leave the upload to the developer? Writing only is phase 1; uploading needs
  credentials the editor would have to keep outside the project.
- One feed per OS, or one feed folder with the three `latest*.yml`? electron-updater reads its own file per OS, so
  one folder works; the publish step has to merge into it rather than replace it.
- Rolling back: electron-updater does not downgrade by default (`allowDowngrade`). A bad release is fixed by a
  newer one; is that enough, or do games need a "pinned version" channel?
- Content patches and NetSync: a host and its players compare `contentHash` before a join. A patched player
  joining an unpatched host is refused today, which is correct; the host's own update path is part of phase 2.
