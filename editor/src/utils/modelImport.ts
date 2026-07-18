import { Node, ModelNode, Model, AnimatedModel, Loader } from 'cleo'

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
export async function parseBundleToRoot(files: File[], name: string): Promise<{ root: Node; children: ModelNode[] }> {
  const isGltf = files.some(f => f.name.toLowerCase().endsWith('.gltf'))
  let parsed: ParsedEntry[] = []
  if (isGltf) {
    try {
      const animated = await Loader.loadAnimatedModelsFromFile(files)
      // The animated loader wraps EVERY primitive in an AnimatedModel, even non-skinned ones. The
      // renderer picks the skinned shader for any AnimatedModel, so a jointless mesh drawn with it throws
      // GL_INVALID_OPERATION (vertex attribute type mismatch). Unwrap non-skinned results back to a plain
      // Model so they use the static shader; keep genuinely skinned models as AnimatedModel.
      parsed = animated.map(p => {
        const m = p.model as AnimatedModel
        const transform = (p as any).transform as ImportedTransform | undefined
        return m.hasSkin ? p : { name: p.name, model: new Model(m.geometry, m.material), transform }
      })
    } catch { parsed = [] }
  }
  if (!parsed.length) parsed = await Model.fromFile({ files })
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
  return { root, children }
}
