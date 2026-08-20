import { Logger, Node, ModelNode, Model, AnimatedModel, Loader } from 'cleo'
import { parseModelFiles, parseGltfFiles, parseModelAsGltfFiles, ImportCancelled } from '../workers/importClient'

/** Reports parse progress (0..1) and the current stage. See importClient for why this exists. */
export type ImportProgress = (fraction: number, stage: string) => void

/**
 * Texture references the loaders could not resolve (mirrors the engine's `TextureLoadReport`; declared
 * locally for the same reason as ImportedTransform below).
 *  - `missingFiles` names images that simply weren't in the upload — pick them and the re-parse fixes it.
 *  - `unloadable` covers references no file can repair: a texture embedded in the model in a format the
 *    browser cannot decode, or bytes that failed to decode.
 *
 * `from` says which material and slot asked for it, so the review modal can explain a bare filename
 * instead of presenting it as an unexplained demand.
 */
export type UnresolvedTexture = { name: string; from: string }
export type TextureLoadReport = { missingFiles: UnresolvedTexture[]; unloadable: UnresolvedTexture[] }

// World TRS of the glTF scene node an entry came from (mirrors the engine's ImportTransform shape;
// declared locally so this file doesn't depend on a freshly rebuilt dist d.ts).
type ImportedTransform = {
  translation: [number, number, number]
  rotation: [number, number, number, number]
  scale: [number, number, number]
}

type ParsedEntry = { name: string; model: Model | AnimatedModel; transform?: ImportedTransform }

// Quaternion → euler DEGREES, inverting gl-matrix's quat.fromEuler composition (q = qz⊗qy⊗qx), which is
// what Node.setRotation feeds. Node.serialize saves only the euler angles, so rotations must be applied
// via setRotation — setQuaternion leaves _euler stale and the rotation would vanish on asset save/load.
function quatToEulerDeg([x, y, z, w]: [number, number, number, number]): [number, number, number] {
  const rad = 180 / Math.PI
  const sy = Math.min(1, Math.max(-1, 2 * (w * y - x * z)))
  return [
    Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * rad,
    Math.asin(sy) * rad,
    Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * rad,
  ]
}

// Parse a bundle's files into an in-memory subtree: a parent Node holding one ModelNode per sub-mesh.
// Animated-first for GLTF (skinned models keep their skeleton/animations), static otherwise. Textures
// referenced by the files land in TextureManager during parse. Reused for the initial import parse and
// the on-Accept re-parse (after the user uploads previously-missing textures).
//
// `textures` reports what the loaders could NOT resolve. Deriving that from the parse rather than from a
// second read of the source files is the only way it can cover every format: an FBX carries its texture
// references in binary, so nothing outside the loader can see them, and the import review used to claim
// "All referenced textures are present" for a model that had loaded none of them.
//
// Three routes, tried in order, each falling through to the next if it yields nothing:
//   .gltf      the engine's own reader, directly.
//   .fbx/.glb  assimp converts to glTF2 first, then that same reader. The detour is what gives those
//              formats SKINNING — the assjson path below has no channel for bones (its ParsedMesh has
//              no bone fields at all), so a rigged character came through as a static mesh. It also
//              brings node transforms, PBR slots and data-URI embedded textures. The trade is that
//              their materials become PBR instead of Blinn-Phong.
//   anything   the assjson path. Still the route for .obj, which cannot be rigged and has nothing to
//              gain from a conversion that would only risk changing how it shades.
export async function parseBundleToRoot(
  files: File[],
  name: string,
  onProgress: ImportProgress = () => {}
): Promise<{ root: Node; children: ModelNode[]; textures: TextureLoadReport }> {
  const extOf = (f: File) => f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
  const isGltf = files.some(f => extOf(f) === '.gltf')
  const convertible = !isGltf && files.some(f => extOf(f) === '.fbx' || extOf(f) === '.glb')

  const textures: TextureLoadReport = { missingFiles: [], unloadable: [] }
  // A route that ends up discarded must not leave its findings behind, or the import review reports
  // missing textures for a parse that no longer counts.
  const forget = () => { textures.missingFiles.length = 0; textures.unloadable.length = 0 }

  // assembleGltfModels only builds an AnimatedModel for primitives that actually carry joint bindings,
  // so no "unwrap every non-skinned AnimatedModel" step is needed — but the reason one existed still
  // holds: the renderer picks the skinned shader for ANY AnimatedModel, and a jointless mesh drawn with
  // it throws GL_INVALID_OPERATION. A skin with zero clips is fine; the gate is bindings, not clips.
  const fromGltf = (descriptors: Parameters<typeof Loader.assembleGltfModels>[0]): ParsedEntry[] =>
    Loader.assembleGltfModels(descriptors, files, textures).map(p => ({
      name: p.name,
      model: p.model,
      transform: p.transform as ImportedTransform | undefined,
    }))

  let parsed: ParsedEntry[] = []
  if (isGltf) {
    try {
      // Parsed off the main thread (descriptors only), then assembled here where a GL context exists.
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
    // Assimp path (.obj, and anything the routes above could not handle). Split across the worker
    // boundary: parseModelFiles runs the WASM conversion off the main thread and returns flat typed
    // arrays, then assembleAssimpModels builds Geometry/Material here — it creates GL textures, so it
    // cannot leave the main thread. Falls back to running the identical parse inline if no worker is
    // available, so behaviour is unchanged in that case, just blocking.
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
    // Place the sub-mesh where its glTF scene node put it (multi-part files author real layouts);
    // entries without a transform (assimp path, models outside the scene graph) stay at the origin.
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
