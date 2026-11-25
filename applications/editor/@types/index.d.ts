// `vite/client` supplies the asset-module declarations this file used to hand-write (*.png, *.jpg,
// *.svg, *.css ...) plus the two suffix families the script editor relies on -- `?raw` for the engine's
// declaration text and `?worker` for Monaco's workers -- and the `import.meta.glob` / `import.meta.env`
// types that replaced webpack's require.context.
/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

// The build-time settings release.yml passes to the web build (repository variables). Absent in dev and in a
// local build, where the gallery reads the local examples/ and the Creator is served at /creator/.
interface ImportMetaEnv {
  /** The examples Worker the web gallery downloads the `examples` release through (utils/examples.ts). */
  readonly VITE_CLEO_EXAMPLES_URL?: string
  /**
   * Cleo Creator's own site, which the web editor's Creator button opens (features/assets/CreatorButton.tsx), and
   * whose origin may connect to the Creator library's storage frame (features/creator/creatorLibraryFrame.ts).
   */
  readonly VITE_CLEO_CREATOR_URL?: string
  /** More origins allowed to connect to the storage frame, comma-separated (a staging site, say). */
  readonly VITE_CLEO_CREATOR_ORIGINS?: string
  /** Dev only: the port the Creator's dev server runs on when opened on its own origin (default 8081). */
  readonly VITE_CLEO_CREATOR_PORT?: string
}
