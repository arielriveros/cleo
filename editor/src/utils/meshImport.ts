import { Node, ModelNode, Model, AnimatedModel, Loader } from 'cleo'

// Parse a bundle's files into an in-memory subtree: a parent Node holding one ModelNode per sub-mesh.
// Animated-first for GLTF (skinned meshes keep their skeleton/animations), static otherwise. Textures
// referenced by the files land in TextureManager during parse. Reused for the initial import parse and
// the on-Accept re-parse (after the user uploads previously-missing textures).
export async function parseBundleToRoot(files: File[], name: string): Promise<{ root: Node; children: ModelNode[] }> {
  const isGltf = files.some(f => f.name.toLowerCase().endsWith('.gltf'))
  let parsed: { name: string; model: Model | AnimatedModel }[] = []
  if (isGltf) {
    try {
      const animated = await Loader.loadAnimatedModelsFromFile(files)
      // The animated loader wraps EVERY primitive in an AnimatedModel, even non-skinned ones. The
      // renderer picks the skinned shader for any AnimatedModel, so a jointless mesh drawn with it throws
      // GL_INVALID_OPERATION (vertex attribute type mismatch). Unwrap non-skinned results back to a plain
      // Model so they use the static shader; keep genuinely skinned meshes as AnimatedModel.
      parsed = animated.map(p => {
        const m = p.model as AnimatedModel
        return m.hasSkin ? p : { name: p.name, model: new Model(m.geometry, m.material) }
      })
    } catch { parsed = [] }
  }
  if (!parsed.length) parsed = await Model.fromFile({ files })
  if (!parsed.length) throw new Error(`No meshes parsed from "${name}"`)

  const root = new Node(name)
  const children: ModelNode[] = []
  for (const p of parsed) {
    const modelNode = new ModelNode(p.name || name, p.model)
    root.addChild(modelNode)
    children.push(modelNode)
  }
  return { root, children }
}
