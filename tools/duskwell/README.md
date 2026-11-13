# Duskwell tooling

The example (`applications/editor/public/examples/duskwell`) is generated: the bundle is output, and these files
are the source of truth.

```
npx vite-node --config vitest.config.ts tools/duskwell/build.ts
node applications/editor/tools/add-example.mjs --list
```

- `level.ts` — the world as a grid of cells (rock, one-way platform, air) carved room by room, the rooms, and the
  markers that place the player, bats, torches, diamonds, checkpoints and the dash relic.
- `inputMap.ts` — the project's input map (Move, Jump, Attack, Dash; keyboard and gamepad).
- `build.ts` — reads the art in `build/platformer`, packs the characters' strips into atlases, makes the
  tilesets (the ruins at 16 pixels a unit, solid and one-way tiles marked), paints the map from `level.ts`,
  builds the scene with the engine's own node classes, attaches the scripts in `examples/scripts/Dusk*.ts`, and
  writes the project as bundle format 2. Ids are derived from names, so a re-run writes the same bytes.

After changing a `Dusk*.ts` script, run the build again: every node embeds its script's source.

`tests/duskwellProject.test.ts` checks the bundle and plays it headless (the floor, the step, the pit gated by
the dash, the bat fight, the respawn).
