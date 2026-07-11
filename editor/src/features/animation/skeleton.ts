import { Scene, Node, ModelNode, AnimatedModel, Animator, Vec, canAccessVariable } from 'cleo'
import type { Skin } from 'cleo'

// Shared helpers for the Animation Editor: resolving the target skinned model, building the joint
// hierarchy from a Skin, and computing per-joint world transforms for the viewport overlay.

export interface AnimationTarget {
  node: ModelNode
  model: AnimatedModel
  animator: Animator
  skin: Skin
}

/** Resolve + validate the skinned ModelNode the Animation Editor operates on. */
export function getAnimationTarget(scene: Scene | null, id: string | null): AnimationTarget | null {
  if (!scene || !id) return null
  const node = scene.getNodeById(id)
  if (!(node instanceof ModelNode)) return null
  const model = node.model
  if (!(model instanceof AnimatedModel) || !model.hasSkin || !model.skin || !node.animator) return null
  return { node, model, animator: node.animator, skin: model.skin }
}

export interface JointTreeNode {
  /** Index into skin.joints (also the index into the animator's final bone matrices). */
  index: number
  nodeIndex: number
  children: JointTreeNode[]
}

/** Build the joint hierarchy (roots + children) from a Skin's flat joint list. */
export function buildJointTree(skin: Skin): JointTreeNode[] {
  const nodeIndexToJoint = new Map<number, number>()
  skin.joints.forEach((j, i) => nodeIndexToJoint.set(j.nodeIndex, i))

  const treeNodes: JointTreeNode[] = skin.joints.map((j, i) => ({ index: i, nodeIndex: j.nodeIndex, children: [] }))
  const roots: JointTreeNode[] = []

  skin.joints.forEach((j, i) => {
    const parentJoint = j.parentIndex !== undefined ? nodeIndexToJoint.get(j.parentIndex) : undefined
    if (parentJoint !== undefined && parentJoint !== i) {
      treeNodes[parentJoint].children.push(treeNodes[i])
    } else {
      roots.push(treeNodes[i])
    }
  })

  return roots
}

/** Display label for a joint (the Skin carries no joint names, so we key off the GLTF node index). */
export function jointLabel(skin: Skin, index: number): string {
  return `Joint ${index} (node ${skin.joints[index].nodeIndex})`
}

/**
 * World-space transform of each joint = node.worldTransform × globalJointTransform, where
 * globalJointTransform = finalBoneMatrix × inverse(inverseBindMatrix). Returns one mat4 per joint
 * (indexed like skin.joints). `bindMatrices` (inverse of each inverseBindMatrix) is precomputed
 * once by the caller to avoid a per-frame matrix inversion.
 */
export function computeJointWorldMatrices(
  node: ModelNode,
  animator: Animator,
  skin: Skin,
  bindMatrices: any[],
): any[] {
  const finals = animator.getFinalBoneMatrices()
  const nodeWorld = node.worldTransform
  const out: any[] = []
  for (let i = 0; i < skin.joints.length; i++) {
    const global = Vec.mat4.create()
    Vec.mat4.multiply(global, finals[i] as any, bindMatrices[i]) // finalBoneMatrix × bindMatrix
    const world = Vec.mat4.create()
    Vec.mat4.multiply(world, nodeWorld as any, global) // node world × joint global
    out.push(world)
  }
  return out
}

/** Precompute inverse-bind-matrix inverses (the joints' bind-pose local→model matrices). */
export function computeBindMatrices(skin: Skin): any[] {
  return skin.joints.map(j => {
    const m = Vec.mat4.create()
    Vec.mat4.invert(m, j.inverseBindMatrix as any)
    return m
  })
}

export function worldPositionOf(matrix: any): [number, number, number] {
  const t = Vec.vec3.create()
  Vec.mat4.getTranslation(t, matrix)
  return [t[0], t[1], t[2]]
}

// ---- Variable-parameter binding (StateMachineEditor "Variable" parameter) ------------------------

export type AccessGroup = 'Self' | 'Parent' | 'Scene'
export interface AccessibleVariable {
  nodeRef: 'self' | 'parent' | string // matches AnimationVariableBinding.nodeRef
  group: AccessGroup
  nodeLabel: string
  varName: string
  varType: 'number' | 'boolean'
}

/**
 * Enumerate the node variables the given source node may bind an animation parameter to, per the
 * access model: its own vars (Self), its parent's protected/public vars (Parent), and any other
 * scene node's public vars (Scene). Only number/boolean variables are usable as transition inputs.
 * Runs against the SOURCE node's real scene (the animation-editor clone is isolated).
 */
export function accessibleNodeVariables(sourceNode: Node | null, sourceScene: Scene | null): AccessibleVariable[] {
  const out: AccessibleVariable[] = []
  if (!sourceNode) return out
  const usable = (t: string) => t === 'number' || t === 'boolean'
  const collect = (owner: Node, requester: Node, nodeRef: string, group: AccessGroup, label: string) => {
    for (const [name, v] of owner.variables) {
      if (name.startsWith('__') || !usable(v.type)) continue
      if (owner !== requester && !canAccessVariable(owner, requester, name)) continue
      out.push({ nodeRef, group, nodeLabel: label, varName: name, varType: v.type as 'number' | 'boolean' })
    }
  }

  collect(sourceNode, sourceNode, 'self', 'Self', 'Self')
  const parent = sourceNode.parent
  if (parent) collect(parent, sourceNode, 'parent', 'Parent', `Parent (${parent.name})`)
  if (sourceScene) {
    for (const node of sourceScene.nodes) {
      if (node === sourceNode || node === parent || node.name.startsWith('__')) continue
      collect(node, sourceNode, node.id, 'Scene', node.name)
    }
  }
  return out
}
