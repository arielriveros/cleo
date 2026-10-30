# @cleo/app-kit

The parts of a Cleo application that are not about any one application: the shared chrome the Editor and
Cleo Creator are both built from. Everything here works against a `CleoEngine` through `EngineHost`, never
against an app's own context, so a new tool on the engine gets the same look and the same panels for free.

| Area | What it holds |
| --- | --- |
| `ui/` | The widget kit: buttons, inputs, sliders, vector/colour/curve/gradient inputs, popovers, modals, panels, property tables, `Topbar`, `OptionsShell`. |
| `docs/` | Markdown docs parsed into the index behind every tooltip. Apps register their own pages with `registerDocSources`. |
| `styles/` | `theme.css` (design tokens, Tailwind layers) and the dockview skin. Pair with `tailwind.preset.js`. |
| `feedback/` | Module-level stores and their views: console log, toasts, in-app dialogs, progress window, loading store. |
| `layout/` | `DockShell`: a dockview workspace with the Cleo skin and a versioned, persisted layout. |
| `engine/` | `EngineHost` (the engine slice shared chrome reads), `ViewportHost`/`useEngineViewport`, the shared view camera and its input map. |
| `renderer/` | Renderer settings, backend selector and performance panels. |
| `gizmo/` | Transform-gizmo picking, handle geometry and drag math. |
| `params/` | `ParamForm`: a parameter set drawn from an engine `ParamSpec` schema. |
| `code/` | Monaco setup with the engine's declarations, WGSL/GLSL language support, code themes. |
| `platform/` | The renderer side of the desktop-shell bridge (`window.cleoDesktop`). |
| `utils/` | IndexedDB, bytes and chunked blobs, event emitter, deep clone, small hooks. |

## Using it from an application

1. Depend on `"@cleo/app-kit": "*"` (it is an npm workspace under `applications/`).
2. Vite: `resolve: { alias: appKitAlias }` from `../app-kit/vite.preset`.
3. TypeScript: `"paths": { "@cleo/app-kit/*": ["../app-kit/src/*"] }` with `"baseUrl": "."`.
4. Tailwind: `presets: [require('../app-kit/tailwind.preset')]` and add `../app-kit/src/**/*.{ts,tsx}` to `content`.
5. Import `@cleo/app-kit/styles/theme.css` once, and wrap the app in an `EngineHostProvider`.

Tests: `npm test` here (pure stores and math, node environment).

## Desktop shell

`desktop/` (beside `src/`, not in it) is the Electron shell: main process, preload, the published-game
templates and the on-disk script workspace. It is its own npm project (`npm run desktop:install`,
`desktop:dev`, `desktop:build` at the repo root) and currently hosts the Editor; see `desktop/README.md`.
