import { describe, it, expect } from 'vitest'
import { AnimatedModel, ModelNode, Node } from 'cleo'
import { modelNodeOf, ownModelNodeOf, ownSkinnedModelNodeOf, skinnedModelNodeOf } from '../src/utils/models'

/**
 * Which nodes the inspector's Model and Animation sections apply to.
 *
 * Both used to ask "does this node's SUBTREE contain a model?", which is far too generous a reading of
 * a question about the SELECTED node. Two independent false positives came out of it:
 *
 *  - **Editor chrome counted as content.** A camera's frustum gizmo (`__debug__CameraModel`) and a
 *    sound's falloff sphere (`__debug__SoundRadius`) are real `ModelNode` children of the node they
 *    annotate, so every Camera and every spatial Sound grew a Model section.
 *  - **Every ancestor lit up** — a Character, a Controller, a LodGroup, any plain holder above a mesh.
 *    Because a template instance draws as a leaf row in the tree, that made the panel look as though
 *    it were keying off the scene rather than the selection.
 *
 * What must NOT regress is the holder ergonomic these walks were widened for in the first place: an
 * imported model instantiates as a plain `Node` carrying `__modelId` with one `ModelNode` per
 * sub-mesh, and that holder is what an author clicks.
 *
 * ## Why the nodes below are built by hand
 *
 * `new Model(...)` allocates GPU buffers, so a real `ModelNode` cannot exist in a headless test — the
 * exact reason this code had no coverage when it broke. A real `Node` is constructed (so ids, parents,
 * children and variables are all genuine) and then re-prototyped, which makes `instanceof ModelNode`
 * true without running a constructor that needs a device. The functions under test are the real ones.
 */

/** A real Node wearing ModelNode's prototype, with the two fields the predicates read. */
function fakeModelNode(name: string, opts: { skinned?: boolean } = {}): ModelNode {
  const node = new Node(name)
  Object.setPrototypeOf(node, ModelNode.prototype)

  const model = opts.skinned ? Object.create(AnimatedModel.prototype) : {}
  if (opts.skinned) Object.defineProperty(model, 'hasSkin', { value: true })

  Object.assign(node, { _model: model, _animator: opts.skinned ? {} : null })
  return node as unknown as ModelNode
}

/** A node with a helper child, the way the reconciler builds one. */
function withHelper(owner: Node, helperName: string): Node {
  owner.addChild(fakeModelNode(helperName))
  return owner
}

const MODEL_ID_VAR = '__modelId'

describe('editor chrome is not content', () => {
  it('a camera with its frustum gizmo has no model', () => {
    // The unambiguous false positive: `__debug__CameraModel` is a ModelNode child of every camera.
    const camera = withHelper(new Node('main camera'), '__debug__CameraModel')
    expect(modelNodeOf(camera)).toBeNull()
    expect(ownModelNodeOf(camera)).toBeNull()
  })

  it('a spatial sound with its falloff sphere has no model', () => {
    const sound = withHelper(new Node('footsteps'), '__debug__SoundRadius')
    expect(modelNodeOf(sound)).toBeNull()
    expect(ownModelNodeOf(sound)).toBeNull()
  })

  it('skips __editor__ children too, not just __debug__ ones', () => {
    const node = withHelper(new Node('holder'), '__editor__SomeGizmo')
    expect(modelNodeOf(node)).toBeNull()
  })
})

describe('the sections follow the SELECTION, not the subtree', () => {
  /** A Controller-ish holder standing above a rigged model, which is the reported case. */
  function characterRig() {
    const controller = new Node('controller')
    const character = new Node('Zombie')
    const mesh = fakeModelNode('Zombie_mesh', { skinned: true })
    controller.addChild(character)
    character.addChild(mesh)
    return { controller, character, mesh }
  }

  it('an ancestor of an animated model gets neither section', () => {
    const { controller, character } = characterRig()
    expect(ownModelNodeOf(controller)).toBeNull()
    expect(ownSkinnedModelNodeOf(controller)).toBeNull()
    expect(ownModelNodeOf(character)).toBeNull()
    expect(ownSkinnedModelNodeOf(character)).toBeNull()
  })

  it('the model itself gets both', () => {
    const { mesh } = characterRig()
    expect(ownModelNodeOf(mesh)).toBe(mesh)
    expect(ownSkinnedModelNodeOf(mesh)).toBe(mesh)
  })

  it('the old subtree walk would have said yes to the ancestor — that was the bug', () => {
    // Kept as a live comparison so the difference between the two predicates stays visible.
    const { controller, mesh } = characterRig()
    expect(modelNodeOf(controller)).toBe(mesh)
    expect(skinnedModelNodeOf(controller)).toBe(mesh)
  })
})

describe('the model-instance holder still works', () => {
  /** What instantiating a model asset produces: a holder carrying __modelId over its sub-meshes. */
  function placedModel() {
    const holder = new Node('Crate')
    holder.setVariable(MODEL_ID_VAR, 'model-1')
    const partA = fakeModelNode('Crate_part_a')
    const partB = fakeModelNode('Crate_part_b')
    holder.addChild(partA)
    holder.addChild(partB)
    return { holder, partA }
  }

  it('the holder speaks for the meshes beneath it', () => {
    const { holder, partA } = placedModel()
    expect(ownModelNodeOf(holder)).toBe(partA)
  })

  it('a sub-mesh still speaks for itself', () => {
    const { partA } = placedModel()
    expect(ownModelNodeOf(partA)).toBe(partA)
  })

  it('but an ancestor ABOVE the holder does not', () => {
    // The line between "holder" and "any ancestor": only the node actually carrying __modelId counts.
    const { holder } = placedModel()
    const parent = new Node('props')
    parent.addChild(holder)
    expect(ownModelNodeOf(parent)).toBeNull()
  })

  it('a skinned holder gets the Animation section, an unskinned one does not', () => {
    const rigged = new Node('Hero')
    rigged.setVariable(MODEL_ID_VAR, 'model-2')
    const skin = fakeModelNode('Hero_body', { skinned: true })
    rigged.addChild(skin)
    expect(ownSkinnedModelNodeOf(rigged)).toBe(skin)

    const { holder } = placedModel()
    expect(ownSkinnedModelNodeOf(holder)).toBeNull()
  })
})

describe('nodes with nothing to show', () => {
  it('a bare node gets neither section', () => {
    const node = new Node('empty')
    expect(ownModelNodeOf(node)).toBeNull()
    expect(ownSkinnedModelNodeOf(node)).toBeNull()
  })

  it('null and undefined are answered, not thrown at', () => {
    expect(ownModelNodeOf(null)).toBeNull()
    expect(ownSkinnedModelNodeOf(undefined)).toBeNull()
  })
})
