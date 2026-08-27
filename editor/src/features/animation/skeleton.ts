import {
  Scene, Node, ModelNode, AnimatedModel, Animator, Vec, canAccessVariable, NODE_BUILTINS,
  skeletonTopology, humanoidSlotOf,
} from 'cleo'
import type { Skin } from 'cleo'
import { getScriptIdOf, type ScriptAsset } from '../../utils/scripts'

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

/**
 * Build the joint hierarchy (roots + children) from a Skin's flat joint list. The node-index/joint-index
 * bridge must come from the engine's shared `skeletonTopology`, which is what the Animator poses through.
 */
export function buildJointTree(skin: Skin): JointTreeNode[] {
  const topo = skeletonTopology(skin)
  const treeNodes: JointTreeNode[] = skin.joints.map((j, i) => ({ index: i, nodeIndex: j.nodeIndex, children: [] }))
  for (let i = 0; i < treeNodes.length; i++) {
    const p = topo.parentJoint[i]
    if (p >= 0) treeNodes[p].children.push(treeNodes[i])
  }
  return topo.roots.map(i => treeNodes[i])
}

/** Per-skin cache: the pairs only depend on the hierarchy, which is fixed once a Skin is parsed. */
const bonePairsCache = new WeakMap<Skin, [number, number][]>()

/**
 * The [joint, parentJoint] pairs to draw a bone segment for, in JOINT indices. Never re-derive these from
 * `joint.parentIndex`: that is a glTF NODE index, and mapping it through a local node→joint map drops every
 * bone whose parent node is not itself a joint (on assimp-converted FBX, every bone).
 */
export function bonePairsOf(skin: Skin): [number, number][] {
  const cached = bonePairsCache.get(skin)
  if (cached) return cached
  const topo = skeletonTopology(skin)
  const pairs: [number, number][] = []
  for (let i = 0; i < skin.joints.length; i++) {
    const p = topo.parentJoint[i]
    if (p >= 0) pairs.push([i, p])
  }
  bonePairsCache.set(skin, pairs)
  return pairs
}

/**
 * Display label for a joint: its `nodeNames` bone name where the rig has one, else the node index. The
 * humanoid slot is appended when recognizable, since that is the term retargeting finds bones by.
 */
export function jointLabel(skin: Skin, index: number): string {
  const nodeIndex = skin.joints[index].nodeIndex
  const name = skin.nodeNames?.get(nodeIndex)
  if (!name) return `Joint ${index} (node ${nodeIndex})`
  const slot = humanoidSlotOf(name)
  return slot ? `${name}  ·  ${slot}` : name
}

/**
 * World-space transform of each joint = node.worldTransform × finalBoneMatrix × inverse(inverseBindMatrix).
 * Returns one mat4 per joint, indexed like skin.joints. `bindMatrices` holds the precomputed inverses.
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
    Vec.mat4.multiply(global, finals[i] as any, bindMatrices[i])
    const world = Vec.mat4.create()
    Vec.mat4.multiply(world, nodeWorld as any, global)
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

export type AccessGroup = 'Built-in' | 'Self' | 'Parent' | 'Scene'
export interface AccessibleVariable {
  // Matches AnimationVariableBinding.nodeRef. Prefer the three keyword RELATIONSHIPS, resolved every frame,
  // over a raw id: ids do not survive the delete/re-add and asset-rebuild cycles that re-instantiate a node.
  nodeRef: 'self' | 'parent' | 'bodied' | string
  group: AccessGroup
  nodeLabel: string
  varName: string
  varType: 'number' | 'boolean'
  /** Where the value is read from. 'builtin' = engine-measured state; 'variable' = a user variable. */
  source: 'variable' | 'builtin'
  /** Built-ins only: one line explaining what the value means, shown as the option's tooltip. */
  hint?: string
}

/**
 * Authoring copy: what each built-in means, for the picker's tooltips. The engine's NODE_BUILTINS owns the
 * names and types; nothing here may introduce a built-in that does not exist there.
 */
const BUILTIN_HINTS: Record<string, string> = {
  currentSpeed: 'How fast the node is ACTUALLY moving (units/s) — 0 when blocked by a wall, whatever its velocity was set to.',
  rawSpeed: 'Unsmoothed currentSpeed. Noisier; prefer currentSpeed for blending.',
  planarSpeed: 'Actual speed across the ground plane, ignoring falling. The usual input for an idle/walk/run blend. NEVER NEGATIVE — it is a magnitude, so a blend sample at a negative speed can never be reached. Use forwardSpeed for that.',
  forwardSpeed: 'Signed speed along the way the node is FACING: negative when backpedalling. The axis to bind if your blend space puts walk-backwards at a negative speed.',
  lateralSpeed: 'Signed strafe speed across the node’s facing. Positive is LEFT, matching planarAngle’s counter-clockwise convention.',
  verticalSpeed: 'Actual speed along gravity — positive rising, negative falling. Good for jump/fall states.',
  planarAngle: 'Travel direction relative to the node’s facing, in degrees: 0 ahead, −90 strafing RIGHT, +90 strafing LEFT, ±180 backwards. Angles are counter-clockwise, matching the engine’s yaw — place your strafe clips accordingly or they play mirrored.',
  worldPlanarAngle: 'Absolute travel heading in degrees, independent of facing. Same convention as a node’s yaw, so it can be assigned straight to setRotation([0, a, 0]).',
  isGrounded: 'True while the body is resting on something solid.',

  planarAcceleration: 'How hard the node is speeding up (+) or slowing down (−) across the ground, units/s². This is what tells a start-run apart from a run.',
  isAccelerating: 'True while the node is deliberately gaining ground speed — the gate for an Idle → StartRun transition.',
  isDecelerating: 'True while the node is deliberately losing ground speed — the gate for a Run → StopRun transition.',
  isMoving: 'True while the node is moving across the ground, with hysteresis so it does not chatter at walking pace.',
  movingTime: 'Seconds the node has been moving continuously; 0 while still. Use it to require a move has lasted before committing to it.',
  stillTime: 'Seconds the node has been still continuously; 0 while moving. The right gate for settling into Idle (e.g. stillTime > 0.2).',
  turnRate: 'How fast the node is turning, degrees/s, signed. Non-zero even when turning in place, where every speed reads 0.',
  angularSpeed: 'Magnitude of the body’s angular velocity, rad/s. Commanded by the solver, not measured — prefer turnRate for animation.',
  isFalling: 'True while off the ground AND losing height. Ask this rather than “not isGrounded”, which is also true on the way up.',
  airTime: 'Seconds airborne continuously; 0 while grounded. Lets airtime rather than clip length drive a fall animation.',
  groundedTime: 'Seconds grounded continuously; 0 while airborne. Use it to stop a landing state firing again mid-run.',
  groundDistance: 'Distance from the collider to the ground below, or −1 when unknown. Needs a Ground Probe on the body (Physics panel).',
  slopeAngle: 'Tilt of the ground under the node, degrees from level. Reads 0 while airborne.',
}

/**
 * Built-ins that can never be negative (vector magnitudes, elapsed times), mapped to the signed built-in to
 * use instead, or undefined where there is none. A blend-space sample at a negative coordinate on an axis
 * bound to one of these is unreachable and its clip never plays.
 */
export const UNSIGNED_BUILTINS: Record<string, string | undefined> = {
  currentSpeed: 'forwardSpeed',
  rawSpeed: 'forwardSpeed',
  planarSpeed: 'forwardSpeed',
  angularSpeed: 'turnRate',
  movingTime: undefined,
  stillTime: undefined,
  airTime: undefined,
  groundedTime: undefined,
  groundDistance: undefined,
}

/** Whether `requester` may bind to a class-script field of `access` declared on `owner`. A script field's
 *  access modifier is declared in the script, not on the node. */
function canAccessScriptField(access: string, owner: Node, requester: Node): boolean {
  if (access === 'public') return true
  if (requester === owner) return true
  if (access === 'protected') return requester.isDescendantOf(owner)
  return false // private, non-owner
}

/**
 * Enumerate the node variables the given source node may bind an animation parameter to: its own (Self),
 * its parent's protected/public (Parent), and other nodes' public (Scene). Only number/boolean variables
 * qualify. Must run against the SOURCE node's real scene — the animation-editor clone is isolated.
 */
export function accessibleNodeVariables(
  sourceNode: Node | null,
  sourceScene: Scene | null,
  scriptAssets: ScriptAsset[] = [],
  /** Ids of nodes the project has authored a rigid body for — the editor's `bodies` map. See below. */
  bodiedIds?: Set<string>,
): AccessibleVariable[] {
  const out: AccessibleVariable[] = []
  if (!sourceNode) return out
  const usable = (t: string) => t === 'number' || t === 'boolean'
  const assetOf = (owner: Node): ScriptAsset | undefined => {
    const id = getScriptIdOf(owner)
    return id ? scriptAssets.find(a => a.id === id) : undefined
  }
  const collect = (owner: Node, requester: Node, nodeRef: string, group: AccessGroup, label: string) => {
    const seen = new Set<string>()
    // Class-script fields.
    for (const v of assetOf(owner)?.variables ?? []) {
      if (v.hidden || !usable(v.type)) continue
      if (owner !== requester && !canAccessScriptField(v.access, owner, requester)) continue
      seen.add(v.name)
      out.push({ nodeRef, group, nodeLabel: label, varName: v.name, varType: v.type as 'number' | 'boolean', source: 'variable' })
    }
    // Legacy inline-script variables.
    for (const [name, v] of owner.variables) {
      if (name.startsWith('__') || seen.has(name) || !usable(v.type)) continue
      if (owner !== requester && !canAccessVariable(owner, requester, name)) continue
      out.push({ nodeRef, group, nodeLabel: label, varName: name, varType: v.type as 'number' | 'boolean', source: 'variable' })
    }
  }

  /**
   * Engine-measured values, offered for Self, Parent and the nearest ancestor with a body — motion built-ins
   * read 0 on a bodyless node. Self and Parent are UNCONDITIONAL: the editor never calls `setBody`, so
   * `bodiedIds` (the authored side map's key set) is the only usable body test here.
   */
  const builtins = (nodeRef: string, label: string) => {
    for (const [name, def] of Object.entries(NODE_BUILTINS)) {
      out.push({
        nodeRef, group: 'Built-in', nodeLabel: label, varName: name,
        varType: def.type, source: 'builtin', hint: BUILTIN_HINTS[name],
      })
    }
  }

  /**
   * The nearest ancestor (or self) with a rigid body. Checks the authored set and the live body, so it
   * resolves both while authoring and at runtime.
   */
  const hasBody = (n: Node) => !!n.body || !!bodiedIds?.has(n.id)
  const bodiedAncestor = (): Node | null => {
    let n: Node | null = sourceNode
    while (n) {
      if (hasBody(n)) return n
      n = n.parent
    }
    return null
  }

  builtins('self', 'Self')
  const parent = sourceNode.parent
  if (parent) builtins('parent', `Parent (${parent.name})`)
  // Must be stored as the RELATIONSHIP 'bodied', never that node's id: re-adding a character, rebuilding a
  // template instance or re-placing from an asset all regenerate node ids, and a stale id binding silently
  // reads its default forever. 'bodied' resolves per frame to whatever is actually moving.
  const bodied = bodiedAncestor()
  if (bodied && bodied !== sourceNode && bodied !== parent) builtins('bodied', `${bodied.name} (body)`)

  collect(sourceNode, sourceNode, 'self', 'Self', 'Self')
  if (parent) collect(parent, sourceNode, 'parent', 'Parent', `Parent (${parent.name})`)
  if (sourceScene) {
    for (const node of sourceScene.nodes) {
      if (node === sourceNode || node === parent || node.name.startsWith('__')) continue
      collect(node, sourceNode, node.id, 'Scene', node.name)
    }
  }
  return out
}
