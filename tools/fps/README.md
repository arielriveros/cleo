# Firing Line tooling

The example is the project folder `examples/firing-line/` (see `examples/README.md`): open it in the desktop
editor and edit it there. It is no longer generated.

- `ingest.mjs` takes a project exported as a zip (`build/Firing-Line.cleoproj.zip`), keeps one scene, writes `Assets/FPS/Scripts/Fps*.ts` into the script library and every node that embeds a copy, and writes
  the project folder examples/firing-line/.
  After a script edit outside the editor: `npm run examples:sync firing-line`. After changing its passes
  (`eventActions.mjs`, `warehouse.mjs`): `node --max-old-space-size=12288 tools/fps/ingest.mjs --passes`.
- GI bakes: `ingest.mjs` gives every GI Volume a stable `bakeId` and carries existing bakes over. After changing the
  level, bake again with `node tools/valley/bakeGI.cjs --example firing-line --scenes "Firing Line"` (stop any editor
  dev server watching `applications/editor/public` first).
- `prepareCharacters.mjs`, `prepareWeapons.mjs`, `prepareTextures.py`, `importClips.mjs` (+ `fpsClips.json`) turned
  the source art (`build/*.fbx`, `build/*.glb`, `Pro Rifle Pack.zip`) into the assets the project was first built
  from. Kept for the record; the project no longer reads their output.
