# The example projects

Each folder here is a Cleo project folder, the same kind the desktop editor creates
([Project folders](../docs/editor/project-folders.md)):

| Folder | Example |
|---|---|
| `valley/` | Valley: a 2 km mountain valley with a day and night cycle, a cinematic tour and a free camera |
| `dungeon/` | Dungeon: a souls-like in a three-level dungeon ([docs/SOULS_DEMO.md](dungeon/docs/SOULS_DEMO.md)) |
| `firing-line/` | Firing Line: a first-person shooter against bots, online too |
| `duskwell/` | Duskwell: a small 2D metroidvania |
| `island/` | Island: a World Creator island with lakes and rivers |
| `sandbox/` | Sandbox: ALS-style locomotion, a car and two guns |

A folder IS the example, and it is edited in the Cleo desktop app and nowhere else: no tool generates or patches
it. The editor's Examples gallery installs a bundle built from the folder, and its tests are its own.

## What is in git, and what is not

Each folder commits its text: `project.cleo`, `ProjectSettings/`, and under `Assets/` every scene, record and
`.meta`, and the scripts as `.ts` files beside the assets that use them. The binary data is not in git:

- the `Blobs/` store (meshes, clips, terrain);
- `Baked/` (GI bakes);
- the image and audio files under `Assets/`.

Each folder's `data.lock.json` lists those files by sha256. They are kept as packs in the repository's
`example-data` release, and `.gitignore` keeps them out of commits.

```
npm run examples:fetch            # download every example's data (once, and after a pull that changed a lock)
npm run examples:fetch valley     # one example's
npm run examples:status           # what differs from the locks: missing, changed, not listed
```

Without its data, an example's tests skip and the gallery leaves it out. The text-only checks
(`npm run examples:check`) still run.

## Editing an example

1. `npm run examples:fetch <slug>`.
2. Open the folder in the Cleo desktop app (**Project ▸ Open Folder…** on `examples/<slug>`) and edit it there.
   Cleo writes every change straight into the folder: what you save is what git sees. Opening it and changing
   nothing writes nothing.
3. Scripts can be edited in VS Code too: they are `Assets/**/*.ts`. Cleo takes an edit in while the project is
   open. After editing one with Cleo closed, `npm run examples:sync <slug>` re-reads the fields the script
   declares into its `.meta`.
4. `npm test` inside the folder runs its tests, and `npm run typecheck` checks its scripts (after `npm run build`
   at the root). The root `npm test` runs every example's tests too.
5. Commit the folder's text and its `data.lock.json` together.
6. If the edit stored new data (a new texture or mesh, a re-bake), upload it: `npm run examples:publish <slug>`
   sends the packs the lock lists as not uploaded yet. It needs `gh auth login` or a `GITHUB_TOKEN` with
   contents: write. Unchanged packs keep their names and are never uploaded again.

### The data lock follows the folder

`npm test` (and every gallery build) first brings the example's lock up to its folder, with no network
(`npm run examples:lock <slug>` does the same by hand):

- data the text now references is locked;
- data nothing references any more (blobs an edit let go of, a bake of a deleted volume) leaves the lock;
- a bucket whose files changed gets a new pack, not uploaded yet.

It tells an edit made here from a lock that changed elsewhere: after a pull that brought a newer lock, the old file
on disk is left for `examples:fetch` to replace, never locked over the pulled one. A file changed both here and in
the lock is reported; `npm run examples:lock -- --take <slug>` keeps yours.

A pack not uploaded yet passes the local checks. CI (`examples:check --remote`) refuses it, so publish before
pushing.

## Adding an example

1. In the Cleo desktop app, create a new project with its location set to `examples/<slug>`.
2. `npm run examples:add -- <slug> --description "…"` writes what the repository keeps around it: `example.json`
   (the gallery card), the tooling (`package.json`, `tsconfig.json`, `vitest.config.mjs`, `.gitignore`, and a
   `.gitattributes` that keeps the data out of Git LFS), a README, `tests/project.test.ts` and `tests/boots.test.ts`,
   and its data lock.
3. Build it in Cleo, `npm test` in the folder, commit it, and `npm run examples:publish <slug>`.

## Tests

`examples/<slug>/tests/` holds the tests that play the example, and the engine, editor and host tests that use it
as their fixture. They run with `npm test` in the folder, or with the root `npm test` (`npm run test:examples` for
these alone). They reach the repository's sources through aliases (`@engine/…`, `@editor/…`, `@host/…`,
`@tools/…`; the example's own scripts as `@/…`), and project-level tests use `cleo/testing`:

```ts
import { openProject } from 'cleo/testing'

const game = await openProject()          // the main scene, loaded as a published game loads it, headless
game.input.setMove(0, 1)
game.step(2)
```

Every example also runs `tests/project.test.ts`, which checks what the editor's own writes keep true:

- every text file is LF;
- its lock covers its text;
- its scripts' fields match their sources;
- it holds nothing the editor would write back on opening it;
- read and written back through the editor's folder codec, it is the same bytes.

`npm run test:example-folders` checks the same promise in the real desktop app: a copy of each example (Duskwell and
Sandbox by default, `E2E_EXAMPLES=valley,dungeon` for others) opens with Open Folder, and opening it writes nothing;
an edit to one material changes only that material's file. It needs a built editor (`npm run editor:build`).

## How the examples ship

A shipped editor carries no examples. Its gallery downloads them from the repository's rolling `examples` release:
one zip per example, listed in its `index.json` (the web editor through the examples Worker, the desktop editor
through its shell; [applications/editor/docs/examples.md](../applications/editor/docs/examples.md)). A merge into
`main` that changed an example re-publishes that example's zip (`release.yml`, `npm run examples:release`); one that
changed the tools that pack them, or the engine, re-publishes all of them. The others keep their zips.

The local gallery bundles (`applications/editor/public/examples/`) are dev-only build output:
`npm run examples:bundle`, and every `editor:dev`, `desktop:dev` and `dev:all` rebuilds the ones whose folder
changed, so an edit shows up in the dev gallery. A build of the editor leaves them out.
