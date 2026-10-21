// The editor's format constants, taken from the editor rather than copied into the generator.
//
// Each of these three stamps a generated project with "this was written by a build that knew about X".
// Hard-coding them is how the shipped example ended up claiming `assetHashVersion: 2` long after the
// hashes moved to 6, and how its VFS ended up naming files `.material` and `.animationField` —
// extensions `kindOfExt` has never recognised, so the asset explorer could not classify a single entry
// it wrote.
//
// None of that produced an error. That is the argument for reading them.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { moduleRegistry } from './tsLoader.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const editorUtil = (...parts) => path.join(HERE, '..', '..', 'editor', 'src', 'utils', ...parts)

// Both of these import nothing but types, which sucrase elides — so they load with an empty stub table.
const load = moduleRegistry()

export const { KIND_EXT } = load(editorUtil('vfs.ts'))
export const { ASSET_HASH_VERSION } = load(editorUtil('assetHash.ts'))

/**
 * `SCENE_REFS_VERSION`, read out of the source TEXT rather than by loading it.
 *
 * references.ts imports the `cleo` barrel for `Scene` and `CameraNode` as values, which would pull a
 * renderer into a Node process that has no GL context. The constant is one integer, so it is matched
 * directly — and a failure to match throws rather than defaulting, because silently writing version 0
 * would mark both scenes partial in the reference viewer with nothing to say why.
 */
function readSceneRefsVersion() {
  const file = editorUtil('references.ts')
  const match = /export const SCENE_REFS_VERSION\s*=\s*(\d+)/.exec(fs.readFileSync(file, 'utf8'))
  if (!match) throw new Error(`SCENE_REFS_VERSION is no longer declared as a literal in ${file}`)
  return Number(match[1])
}

export const SCENE_REFS_VERSION = readSceneRefsVersion()

if (!KIND_EXT?.animation || !KIND_EXT.rig) throw new Error('KIND_EXT did not load out of vfs.ts')
if (!Number.isInteger(ASSET_HASH_VERSION)) throw new Error('ASSET_HASH_VERSION did not load out of assetHash.ts')
