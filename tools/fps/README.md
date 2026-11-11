# Firing Line tooling

The example (`applications/editor/public/examples/firing-line`) is a project that was edited in the editor and
exported; that project is the source of truth for the scene, templates, materials, models, animations, sounds and
baked GI. It is no longer generated.

- `ingest.mjs` takes the exported zip (`build/Firing-Line.cleoproj.zip`), keeps one scene, writes the current
  `examples/scripts/Fps*.ts` into the script library and every node that embeds a copy, and repacks the bundle.
  After a script-only edit: `node --max-old-space-size=12288 tools/fps/ingest.mjs --scripts-only`.
- GI bakes: `ingest.mjs` gives every GI Volume a stable `bakeId` and carries existing bakes over. After changing the
  level, bake again with `node tools/valley/bakeGI.cjs --example firing-line --scenes "Firing Line"` (stop any editor
  dev server watching `applications/editor/public` first).
- `prepareCharacters.mjs`, `prepareWeapons.mjs`, `prepareTextures.py`, `importClips.mjs` (+ `fpsClips.json`) turned
  the source art (`build/*.fbx`, `build/*.glb`, `Pro Rifle Pack.zip`) into the assets the project was first built
  from. Kept for the record; the project no longer reads their output.
