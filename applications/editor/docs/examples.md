# Example projects

The editor has a gallery of ready-made projects. Anyone can pick one and get a full copy of it as a new project
of their own: their existing projects are untouched. This is what a first-time visitor sees on the boot launcher
instead of an empty list.

The examples themselves are **project folders in the repository**, `examples/<slug>/`, edited in the desktop
editor like any project folder and nowhere else: no tool generates them (see
[examples/README.md](../../../examples/README.md)). What the gallery installs is a **bundle built from each
folder**. A shipped editor downloads it; nothing is built into the editor or its installer.

## Where the gallery reads from

| Editor | Reads | From |
| --- | --- | --- |
| Web (editor.cleoengine.com) | the examples Worker (`VITE_CLEO_EXAMPLES_URL`) | the repository's `examples` release, one zip per example |
| Desktop (packaged) | `examples/…` on its own origin, which the shell fetches | the same release (`app-kit/desktop/main.js`) |
| Dev server | `examples/…` | the local gallery, `applications/editor/public/examples/<slug>/` |

The web editor cannot read the release itself: GitHub's release downloads send no `Access-Control-Allow-Origin`
header, and a page may only read a response from another site that allows it. The Worker
([tools/ci/examples-worker](../../../tools/ci/examples-worker/worker.mjs)) fetches each file on the page's behalf
and adds the header; it stores nothing. The desktop shell fetches the release from its main process, where there
is no such rule.

## The `examples` release

`release.yml` publishes it on every merge that changed an example (or the tools that pack them, or the engine),
with `npm run examples:release` ([tools/examples/release.mjs](../../../tools/examples/release.mjs)):

```
index.json                 # version 2: one entry per example, naming its zip, sha256 and thumbnail
<slug>-<sha8>.zip          # the bundle at the archive root: what Import Project reads
<slug>-<sha8>.png          # its thumbnail
```

Only the examples a merge touched are rebuilt; the rest keep their zips. A zip and its thumbnail are named by their
content, and the same folder always zips to the same bytes, so an unchanged example keeps its name and is never
uploaded again. The index is uploaded last, so it never names a file that is not there yet. The release is never the
latest one: the desktop updater reads the latest release.

By hand (`gh auth login`, or a `GITHUB_TOKEN` with contents: write):

```
npm run examples:fetch valley              # its data, from the example-data release
npm run examples:release -- valley         # build its zip into build/examples-release, merged into the live index
npm run examples:release -- valley --publish
```

## The local gallery (dev)

```
npm run examples:fetch      # the examples' binary data, from the repository's example-data release
npm run examples:bundle     # every example folder -> its gallery bundle, and index.json (version 1)
```

`editor:dev`, `desktop:dev` and `dev:all` run the same build through `tools/ensureExamples.mjs`. It first brings
each example's data lock up to its folder (`examples:lock`, no network), so data an edit stored is the example's, then
rebuilds only the examples whose folder changed (a stamp of the folder's files and of the tools that pack it). An
example whose data has not been fetched is left out with a hint: the dev start goes on. A build of the editor leaves
`public/examples` out of `dist/` (vite.config.ts), so a local desktop build carries none of it either.

```
applications/editor/public/examples/
  index.json                     # generated from the bundles on disk (tools/exampleKit/galleryIndex.mjs)
  <slug>/
    example.json                 # name / description / order / createdAt, from the example folder
    manifest.json  vfs.json  libraries/*.json  scenes/<sceneId>.json
    assets.json  assets.bin, assets.1.bin, …    # the payloads (bundle format 2)
    .build.json                  # the stamp it was built from
```

The folder is never listed over HTTP, and never needs to be: the library file names are fixed,
`manifest.sceneMetas` names every scene file, and `assets.json` names every payload part. An index entry with a
`zip` is a release entry; one without is a local folder.

## Adding an example

1. In the desktop editor, create a new project with its location set to `examples/<slug>`, and build it there.
2. `npm run examples:add -- <slug> --description "…" [--order <n>]` writes `example.json` (the card: `name`,
   `description`, `order`, the gallery's sort key, and `createdAt`), the repository's tooling files, a README, the
   two shared tests, and its `data.lock.json`.
3. Commit the folder, and `npm run examples:publish <slug>` puts its binary data in the example-data release. The
   merge that brings it to `main` publishes its zip.

## Things to know

- **Installing on desktop** writes the example as a new project folder where the user picks
  (`installBundleToFolder`). The codec's output is a fixed point, so that folder is the same as the one in the
  repository, apart from its uid.
- **A downloaded zip is checked before it is opened.** `downloadExampleZip` compares it with the index's sha256 and
  refuses one that was cut short or replaced.
- **No gallery is normal.** `loadExampleIndex()` treats a missing `index.json` as an empty list, and the Examples tab
  simply does not appear: a checkout without the examples' data, or a web build made without the Worker.
- **Firebase's SPA rewrite makes missing files look like successes.** `applications/editor/firebase.json` rewrites
  `"**" → "/index.html"`, so a wrong path returns HTTP 200 carrying the editor's HTML rather than a 404.
  `applications/editor/src/utils/examples.ts` checks every response for that and reports the path; do not remove
  those checks.

## Code

| Where | What |
| --- | --- |
| [`tools/examples/release.mjs`](../../../tools/examples/release.mjs) | the `examples` release: zips, index, publish |
| [`tools/ci/examples-worker/worker.mjs`](../../../tools/ci/examples-worker/worker.mjs) | the web gallery's way to the release |
| [`tools/examples/gallery.mjs`](../../../tools/examples/gallery.mjs) | example folder -> gallery bundle, the stamp, the index |
| [`tools/exampleKit/folder.mjs`](../../../tools/exampleKit/folder.mjs) | reading and writing example folders from Node, on the editor's folder codec |
| [`applications/editor/src/utils/examples.ts`](../src/utils/examples.ts) | where the gallery reads from, the index loader, the zip download, `importExample` |
| [`applications/editor/src/utils/bundleRead.ts`](../src/utils/bundleRead.ts) | the single reader of the bundle layout, shared with the .zip importer |
| [`applications/editor/src/features/projects/ExamplesGallery.tsx`](../src/features/projects/ExamplesGallery.tsx) | the cards |

Importing an example ends at `applyBundleAsNewProject` in `applications/editor/src/utils/bundleImport.ts` (web) or
`installBundleToFolder` (desktop), the same functions a zip import uses. An example is not a special kind of
project: once it lands it is an ordinary one.
