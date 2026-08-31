import { Logger, Node, ModelNode, Model, AnimatedModel, Loader } from 'cleo'
import { parseModelFiles, parseGltfFiles, parseModelAsGltfFiles, ImportCancelled } from '../workers/importClient'
import { clamp } from './math';

/** Reports parse progress (0..1) and the current stage. See importClient for why this exists. */
export type ImportProgress = (fraction: number, stage: string) => void

/**
 * Texture references the loaders could not resolve. Mirrors the engine's `TextureLoadReport`, declared
 * locally for the same reason as ImportedTransform below.
 *  - `missingFiles` names images that were not in the upload; picking them and re-parsing fixes it.
 *  - `unloadable` covers references no file can repair — bytes the browser cannot decode.
 *  - `from` names the material and slot that asked, so a bare filename can be explained.
 */
export type UnresolvedTexture = { name: string; from: string }
export type TextureLoadReport = { missingFiles: UnresolvedTexture[]; unloadable: UnresolvedTexture[] }

// World TRS of the glTF scene node an entry came from. Mirrors the engine's ImportTransform shape,
// declared locally so this file does not depend on a freshly rebuilt dist d.ts.
type ImportedTransform = {
  translation: [number, number, number]
  rotation: [number, number, number, number]
  scale: [number, number, number]
}

type ParsedEntry = { name: string; model: Model | AnimatedModel; transform?: ImportedTransform }

// Quaternion → euler DEGREES, inverting gl-matrix's quat.fromEuler composition (q = qz⊗qy⊗qx).
// Rotations must be applied via setRotation: Node.serialize saves only the eulers, and setQuaternion
// leaves _euler stale, so the rotation vanishes on save/load.
function quatToEulerDeg([x, y, z, w]: [number, number, number, number]): [number, number, number] {
  const rad = 180 / Math.PI
  const sy = clamp(2 * (w * y - x * z), -1, 1)
  return [
    Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * rad,
    Math.asin(sy) * rad,
    Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * rad,
  ]
}

// Parse a bundle's files into an in-memory subtree: a parent Node holding one ModelNode per sub-mesh.
// Textures referenced by the files land in TextureManager during parse. Used for the initial import parse
// and for the on-Accept re-parse after the user uploads previously-missing textures.
//
// `textures` must be derived from the PARSE, not from a second read of the source files: an FBX carries
// its texture references in binary, where nothing outside the loader can see them.
//
// Three routes, tried in order, each falling through to the next if it yields nothing:
//   .gltf      the engine's own reader, directly.
//   .fbx/.glb  assimp converts to glTF2 first, then that same reader. The detour is what gives those
//              formats SKINNING, node transforms, PBR slots and data-URI embedded textures — the assjson
//              path has no channel for bones. The trade is that their materials become PBR, not Blinn-Phong.
//   anything   the assjson path, and the route for .obj, which cannot be rigged.
export async function parseBundleToRoot(
  files: File[],
  name: string,
  onProgress: ImportProgress = () => {}
): Promise<{ root: Node; children: ModelNode[]; textures: TextureLoadReport }> {
  const extOf = (f: File) => f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
  const isGltf = files.some(f => extOf(f) === '.gltf')
  const convertible = !isGltf && files.some(f => extOf(f) === '.fbx' || extOf(f) === '.glb')

  const textures: TextureLoadReport = { missingFiles: [], unloadable: [] }
  // A discarded route must not leave its findings behind, or the review reports missing textures for a
  // parse that no longer counts.
  const forget = () => { textures.missingFiles.length = 0; textures.unloadable.length = 0 }

  // The renderer picks the skinned shader for ANY AnimatedModel, and a jointless mesh drawn with it
  // throws GL_INVALID_OPERATION — so the gate is joint BINDINGS, not clips. A skin with zero clips is fine.
  const fromGltf = (descriptors: Parameters<typeof Loader.assembleGltfModels>[0]): ParsedEntry[] =>
    Loader.assembleGltfModels(descriptors, files, textures).map(p => ({
      name: p.name,
      model: p.model,
      transform: p.transform as ImportedTransform | undefined,
    }))

  let parsed: ParsedEntry[] = []
  if (isGltf) {
    try {
      // Parsed off the main thread (descriptors only), assembled here where a GL context exists.
      const descriptors = await parseGltfFiles(files, true, onProgress)
      onProgress(0.95, 'Building meshes')
      parsed = fromGltf(descriptors)
    } catch (e) {
      if (e instanceof ImportCancelled) throw e
      parsed = []
      forget()
    }
  } else if (convertible) {
    try {
      // Convert and parse both happen in the worker; only the descriptors come back.
      const descriptors = await parseModelAsGltfFiles(files, true, onProgress)
      onProgress(0.95, 'Building meshes')
      parsed = fromGltf(descriptors)
    } catch (e) {
      if (e instanceof ImportCancelled) throw e
      Logger.warn(`glTF2 conversion of "${name}" failed (${e}); falling back to the direct parse`, 'Import')
      parsed = []
      forget()
    }
  }
  if (!parsed.length) {
    // Assimp path (.obj, and anything the routes above could not handle). parseModelFiles runs the WASM
    // conversion off the main thread; assembleAssimpModels creates GL textures and so must stay here.
    // Falls back to the identical parse inline, blocking, when no worker is available.
    forget()
    const descriptors = await parseModelFiles(files, onProgress)
    onProgress(0.95, 'Building meshes')
    const assembled = await Loader.assembleAssimpModels(descriptors, files, textures)
    parsed = assembled.map(a => ({ name: a.name, model: new Model(a.geometry, a.material) }))
  }
  if (!parsed.length) throw new Error(`No models parsed from "${name}"`)

  const root = new Node(name)
  const children: ModelNode[] = []
  for (const p of parsed) {
    const modelNode = new ModelNode(p.name || name, p.model)
    // Place the sub-mesh where its glTF scene node put it; an entry with no transform stays at the origin.
    const t = (p as any).transform as ImportedTransform | undefined
    if (t) {
      modelNode.setPosition(t.translation)
      modelNode.setRotation(quatToEulerDeg(t.rotation))
      modelNode.setScale(t.scale)
    }
    root.addChild(modelNode)
    children.push(modelNode)
  }
  return { root, children, textures }
}
