// The editor's pure modules (bundle reader and writer, the project-folder codec, asset hashes), transpiled once
// for the Node tools and tests that read and write the shipped examples. One registry, so every tool shares one
// copy of each module (see tsLoader.mjs for why the tools run the editor's own code rather than a copy of it).

import path from 'path'
import { fileURLToPath } from 'url'
import { moduleRegistry } from './tsLoader.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const UTILS = path.join(ROOT, 'applications', 'editor', 'src', 'utils')

let load = null
/** A module of the editor's `src/utils/`, by its path there (`'folder/projectCodec.ts'`). */
export function editorModule(rel) {
  load ??= moduleRegistry()
  return load(path.join(UTILS, rel))
}

/** A module of the editor's `src/`, by its path there (`'features/projectFolder/scaffoldText.ts'`). */
export function editorSrcModule(rel) {
  load ??= moduleRegistry()
  return load(path.join(UTILS, '..', rel))
}

/** `bundle.ts` + `bundleRead.ts`: the bundle format's reader and writer. */
let bundle = null
export function bundleModules() {
  return bundle ??= { ...editorModule('bundle.ts'), ...editorModule('bundleRead.ts') }
}

/** The project-folder codec (`projectCodec.ts`), its layout rules (`layout.ts`) and the asset hashes. */
let folder = null
export function folderModules() {
  return folder ??= {
    ...editorModule('folder/projectCodec.ts'),
    ...editorModule('folder/layout.ts'),
    ...editorModule('folder/jsonText.ts'),
    ...editorModule('folder/scriptCopies.ts'),
    ...editorModule('assetHash.ts'),
  }
}
