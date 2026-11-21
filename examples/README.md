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

A folder IS the example. The editor's Examples gallery installs a bundle built from it, and its tests are its own.

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

## Changing an example

1. `npm run examples:fetch <slug>`.
2. Open the folder in the Cleo desktop app (**Project ▸ Open Folder…**) and edit it there. What you save is
   what git sees. Close the project in Cleo before running a tool that writes the folder.
3. Scripts can be edited in VS Code too: they are `Assets/**/*.ts`. After editing one outside Cleo, run
   `npm run examples:sync <slug>`, which re-reads the fields the script declares into its `.meta`.
4. `npm test` inside the folder runs its tests, and `npm run typecheck` checks its scripts (after `npm run build`
   at the root). The root `npm test` runs every example's tests too.
5. If the data changed (a new texture, a moved mesh, a new bake), `npm run examples:publish <slug>` uploads the
   packs that are new to the release and rewrites `data.lock.json`. It needs `gh auth login` or a `GITHUB_TOKEN`
   with contents: write. Unchanged packs keep their names and are never uploaded again.
6. Commit the folder's text and its `data.lock.json` together. `npm run examples:check` fails when the text
   references data the lock does not list. CI checks that every pack the locks name is in the release.

Some examples are also written by generators, which write the same folder:

| Example | Generator |
|---|---|
| Sandbox | `tools/sandbox/build.ts` |
| Duskwell | `tools/duskwell/build.ts` |
| Island | `tools/island/build.ts` (from the Valley's folder) |
| Valley, Dungeon | patched in place by the tools in `tools/valley/` |
| Firing Line | `tools/fps/ingest.mjs` brings in a project exported as a zip |

Rerunning a generator on an unchanged input leaves `git status` clean.

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

Every example also runs `tests/project.test.ts`, which checks four things:

- the folder is exactly what the editor's folder codec writes;
- its scripts' fields match their sources;
- its lock covers its text;
- its templates and colliders follow the rules the editor relies on.

`npm run test:example-folders` checks the same promise in the real desktop app: a copy of each example (Duskwell and
Sandbox by default, `E2E_EXAMPLES=valley,dungeon` for others) opens with Open Folder, and opening it writes nothing;
an edit to one material changes only that material's file. It needs a built editor (`npm run editor:build`).

The gallery bundles (`applications/editor/public/examples/`) are build output: `npm run examples:bundle`, and every
`editor:dev`, `desktop:dev` and `editor:build` rebuilds the ones whose folder changed.
