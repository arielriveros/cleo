# Applications

The programs built on the Cleo engine (`../src`). This folder is an npm workspace root: run `npm ci`
here once (or `npm run apps:install` at the repository root) and every app shares one `node_modules`.

| Folder | What it is | Run |
| --- | --- | --- |
| `app-kit/` | `@cleo/app-kit`: the chrome every app shares (widgets, docking, docs tooltips, console/toasts/dialogs, viewport host and camera, renderer panels, gizmo math, parameter forms). See its README. | `npm test` |
| `app-kit/desktop/` | The Electron desktop shell, hosting the Editor (its own npm project, outside the workspace). | `npm run desktop:dev` (root) |
| `editor/` | Cleo Editor: scenes, assets, play, publish. | `npm run editor:dev` (root) |
| `creator/` | Cleo Creator: procedural assets. World Creator (heightmaps) and FX Creator (fire/smoke flipbooks). Docs in `../docs/creator`. | `npm run creator:dev` (root), port 8082 |
| `mcp/` | `cleo-mcp`: a Model Context Protocol server that lets an AI agent (Claude Code, Claude Desktop) drive a running Editor: scene edits, scripts, materials, screenshots, Play. Its own npm project, outside the workspace. See its README. | `npm install && npm test` in `mcp/` |

Every app compiles the engine from source through the shared root `vite.config.ts` (the `cleo` alias and
the shader plugin), and resolves `@cleo/app-kit/...` through `app-kit/vite.preset.ts`. Types for `cleo`
come from the root `dist/` declaration tree, so run `npm run build` at the root before typechecking.
