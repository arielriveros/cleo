// `vite/client` supplies the asset-module declarations this file used to hand-write (*.png, *.jpg,
// *.svg, *.css ...) plus the two suffix families the script editor relies on -- `?raw` for the engine's
// declaration text and `?worker` for Monaco's workers -- and the `import.meta.glob` / `import.meta.env`
// types that replaced webpack's require.context.
/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />
/// <reference path="../../../src/wgsl.d.ts" />

// What release.yml builds the web Creator with (the repository variable CLEO_EDITOR_ORIGIN).
interface ImportMetaEnv {
  /**
   * The editor's origin, when the Creator is served on a site of its own: its library is reached through the
   * editor's storage frame there (src/app/editorLibrary.ts). Absent when the Creator is on the editor's origin.
   */
  readonly VITE_CLEO_EDITOR_ORIGIN?: string
}
