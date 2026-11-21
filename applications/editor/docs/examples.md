# Example projects

The editor ships a gallery of ready-made projects. Anyone can pick one and get a full copy of it as a new project
of their own: their existing projects are untouched. This is what a first-time visitor sees on the boot launcher
instead of an empty list.

The examples themselves are **project folders in the repository**, `examples/<slug>/`, edited in the desktop
editor like any project folder (see [examples/README.md](../../../examples/README.md)). What the gallery installs
is a **bundle built from each folder**, in `applications/editor/public/examples/<slug>/`. That folder is build
output and never committed. It is static content shipped next to the app: there is no server, no API and no CDN,
which is also why examples work offline in the desktop build.

## Building the gallery

```
npm run examples:fetch      # the examples' binary data, from the repository's example-data release
npm run examples:bundle     # every example folder -> its gallery bundle, and index.json
```

`editor:dev`, `desktop:dev` and `editor:build` run the same build through `tools/ensureExamples.mjs`. It rebuilds
only the examples whose folder changed (a stamp of the folder's files and of the tools that pack it). An example
whose data has not been fetched is left out with a hint: the dev start goes on. A release build sets
`CLEO_EXAMPLES_REQUIRED=1`, which makes a missing example an error, so the desktop installer always carries all of
them.

## Adding an example

1. Build the project, in the desktop editor as a project folder or anywhere and exported as a `.zip`.
2. Put it in `examples/<slug>/`: copy the project folder there, or import a zip with
   `npm --prefix applications/editor run examples:add -- path/to/MyGame.cleoproj.zip --slug my-game`. The tooling
   files come from `node tools/examples/scaffold.mjs <slug>`.
3. Write `examples/<slug>/example.json`: `name`, `description`, `order` (the gallery's sort key), `createdAt`.
4. `npm run examples:publish <slug>` puts its binary data in the release and writes its `data.lock.json`.
5. Commit the folder.

## What is in a gallery bundle

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
`manifest.sceneMetas` names every scene file, and `assets.json` names every payload part.

## Things to know

- **Installing on desktop** writes the example as a new project folder where the user picks
  (`installBundleToFolder`). The codec's output is a fixed point, so that folder is the same as the one in the
  repository, apart from its uid.
- **A checkout with no gallery is normal.** `loadExampleIndex()` treats a missing `index.json` as an empty list,
  and the Examples tab simply does not appear.
- **Firebase's SPA rewrite makes missing files look like successes.** `applications/editor/firebase.json` rewrites
  `"**" → "/index.html"`, so a wrong path returns HTTP 200 carrying the editor's HTML rather than a 404.
  `applications/editor/src/utils/examples.ts` checks every response for that and reports the path; do not remove
  those checks. (The web deploy ignores `examples/**`.)

## Code

| Where | What |
| --- | --- |
| [`tools/examples/gallery.mjs`](../../../tools/examples/gallery.mjs) | example folder -> gallery bundle, the stamp, the index |
| [`tools/exampleKit/folder.mjs`](../../../tools/exampleKit/folder.mjs) | reading and writing example folders from Node, on the editor's folder codec |
| [`applications/editor/src/utils/examples.ts`](../src/utils/examples.ts) | index loader, the fetch-backed `BundleSource`, `importExample` |
| [`applications/editor/src/utils/bundleRead.ts`](../src/utils/bundleRead.ts) | the single reader of the bundle layout, shared with the .zip importer |
| [`applications/editor/src/features/projects/ExamplesGallery.tsx`](../src/features/projects/ExamplesGallery.tsx) | the cards |

Importing an example ends at `applyBundleAsNewProject` in `applications/editor/src/utils/bundleImport.ts` (web) or
`installBundleToFolder` (desktop), the same functions a zip import uses. An example is not a special kind of
project: once it lands it is an ordinary one.
