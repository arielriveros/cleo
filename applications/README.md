# Applications

The programs built on the Cleo engine (`../src`). This folder is an npm workspace root: run `npm ci`
here once (or `npm run apps:install` at the repository root) and every app shares one `node_modules`.

| Folder | What it is | Run |
| --- | --- | --- |
| `app-kit/` | `@cleo/app-kit`: the chrome every app shares (widgets, docking, docs tooltips, console/toasts/dialogs, viewport host and camera, renderer panels, gizmo math, parameter forms). See its README. | `npm test` |
| `editor/` | Cleo Editor: scenes, assets, play, publish. | `npm run editor:dev` (root) |
| `creator/` | Cleo Creator: procedural assets. World Creator (heightmaps) and FX Creator (fire/smoke flipbooks). Docs in `../docs/creator`. | `npm run creator:dev` (root) |

Every app compiles the engine from source through the shared root `vite.config.ts` (the `cleo` alias and
the shader plugin), and resolves `@cleo/app-kit/...` through `app-kit/vite.preset.ts`. Types for `cleo`
come from the root `dist/` declaration tree, so run `npm run build` at the root before typechecking.
