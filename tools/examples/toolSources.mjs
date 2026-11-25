// The sources whose change rebuilds every example's gallery bundle: the tools that write a bundle, and the editor
// modules they run to read an example folder and to lay the bundle out. tools/examples/gallery.mjs stamps a bundle
// with them; tools/ci/affected.mjs reads them to tell which merges re-publish the examples.
//
// A module of its own, with no imports, so the CI's change check can read it before anything is installed.

export const TOOL_SOURCES = [
  'tools/examples/gallery.mjs', 'tools/examples/bundleWriter.mjs', 'tools/exampleKit/folder.mjs',
  'tools/exampleKit/editorModules.mjs', 'tools/exampleKit/tsLoader.mjs',
  'applications/editor/src/utils/folder/projectCodec.ts', 'applications/editor/src/utils/folder/codec.ts',
  'applications/editor/src/utils/folder/layout.ts', 'applications/editor/src/utils/payloads.ts',
  'applications/editor/src/utils/bundle.ts', 'applications/editor/src/utils/bundleRead.ts',
  'applications/editor/src/utils/bundleAssets.ts',
]
