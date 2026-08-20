# Example projects

The editor ships a gallery of ready-made projects. Anyone can pick one and get a full copy of it as a new
project of their own — their existing projects are untouched. This is what a first-time visitor sees on the
boot launcher instead of an empty list.

An example is nothing more than a **project export, unzipped into a folder that ships with the editor**.
There is no server, no API and no CDN: the folder is static content sitting next to the app, which is also
why examples work offline in the desktop build.

## Adding or updating one

1. **Build the project** in your local editor, exactly as you want people to receive it. Open the scene you
   want them to land on — that is what gets recorded as the open scene, and its saved thumbnail becomes the
   gallery cover image.
2. **Export it**: menu bar → **Export**. You get `<name>.cleoproj.zip`.
3. **Ingest it**:

   ```
   npm --prefix editor run examples:add -- path/to/MyGame.cleoproj.zip \
       --slug third-person-demo \
       --name "Third Person Demo" \
       --description "Character controller, camera rig and an animation blend space."
   ```

   This unzips into `editor/public/examples/third-person-demo/`, writes `thumbnail.png` from the main
   scene's thumbnail, and regenerates `examples/index.json`.
4. **Commit `editor/public/examples/`.** Merging to `main` deploys it with the editor — no other change is
   needed.

Re-running step 3 with an updated export replaces the folder in place. The display name, description and
sort order live in `<slug>/example.json` and are read back and preserved, so you only need to pass the flags
you actually want to change.

Other commands:

```
npm --prefix editor run examples:list                            # the catalogue, with sizes
npm --prefix editor run examples:add -- --remove third-person-demo
```

## What is in a folder

```
editor/public/examples/
  index.json                     # GENERATED — never edit by hand; the CLI rebuilds it from a disk scan
  third-person-demo/
    example.json                 # name / description / order   (hand-editable, preserved on re-ingest)
    thumbnail.png                # cover image
    manifest.json                # ─ from here down, the export's zip contents, verbatim ─
    vfs.json
    libraries/*.json
    scenes/<sceneId>.json
    textures/index.json
    textures/0.bin, 1.bin, …
```

The folder is never listed over HTTP, and never needs to be. The file set is derivable: the library
filenames are fixed, `manifest.sceneMetas` names every scene file, and `textures/index.json` names every
texture payload. Only the catalogue — which examples exist and what they are called — has to be written
down, and the CLI generates that from the folders themselves so it cannot drift.

## Things to know

- **Size matters here more than usual.** Textures are stored uncompressed, they go into git, and they are
  re-served on every deploy. The CLI prints the folder size and warns past 50 MB. Prefer examples with
  modest art over showcases built on multi-hundred-megabyte models.
- **Only full project exports.** An asset pack (`assets.cleopack.zip`) is rejected — an example has to carry
  scenes.
- **A checkout with no examples is normal.** `loadExampleIndex()` treats a missing `index.json` as an empty
  list and the Examples tab simply does not appear.
- **Firebase's SPA rewrite makes missing files look like successes.** `editor/firebase.json` rewrites
  `"**" → "/index.html"`, so a wrong path returns HTTP 200 carrying the editor's HTML rather than a 404.
  `editor/src/utils/examples.ts` checks every response for that and reports the path; do not remove those
  checks.

## Code

| Where | What |
| --- | --- |
| [`editor/tools/add-example.mjs`](../editor/tools/add-example.mjs) | the ingest CLI |
| [`editor/src/utils/examples.ts`](../editor/src/utils/examples.ts) | index loader, the fetch-backed `BundleSource`, `importExample` |
| [`editor/src/utils/bundleRead.ts`](../editor/src/utils/bundleRead.ts) | the single reader of the bundle layout, shared with the .zip importer |
| [`editor/src/features/projects/ExamplesGallery.tsx`](../editor/src/features/projects/ExamplesGallery.tsx) | the cards |
| [`editor/src/features/projects/ProjectsBrowser.tsx`](../editor/src/features/projects/ProjectsBrowser.tsx) | the tab host used by the launcher and the Projects modal |

Importing an example ends at `applyBundleAsNewProject` in `editor/src/utils/bundleImport.ts` — the same
function the menu bar's **Import → New project** uses. An example is not a special kind of project; once
it lands it is an ordinary one.
