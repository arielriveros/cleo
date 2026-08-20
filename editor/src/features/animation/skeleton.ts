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
 * Build the joint hierarchy (roots + children) from a Skin's flat joint list.
 *
 * Delegates the node-index/joint-index bridge to the engine's shared `skeletonTopology`, which is also what
 * the Animator poses through — so the tree drawn here cannot disagree with the hierarchy actually being
 * evaluated, and malformed rigs (a self-parented bone, a cycle) degrade the same way in both.
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
 * The [joint, parentJoint] pairs to draw a bone segment for, in JOINT indices.
 *
 * Shared rather than re-derived, because both overlays that draw a skeleton had grown the same wrong
 * copy: mapping `joint.parentIndex` — a glTF NODE index — through a local node→joint map. That drops
 * every bone whose parent node is not itself a joint, which on an assimp-converted FBX is *every* bone
 * (its importer preserves pivots, so `Bone_$AssimpFbx$_Rotation` sits between each pair). The visible
 * result was a skeleton drawn as two lonely segments while the tree panel — which already went through
 * `skeletonTopology` — showed the hierarchy correctly.
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
 * Display label for a joint: its real bone name where the rig has one, else the node index.
 *
 * The skin DOES carry names (`nodeNames`, parsed from the GLTF and preserved through serialization); this
 * used to ignore them and print `Joint 12 (node 34)` for everything, which is unreadable for picking out a
 * foot or a hand. The humanoid slot is appended when the name is recognizable, because that is the term the
 * engine itself uses for the bone — retargeting and any future rig feature find bones by slot, not by name.
 */
export function jointLabel(skin: Skin, index: number): string {
  const nodeIndex = skin.joints[index].nodeIndex
  const name = skin.nodeNames?.get(nodeIndex)
  if (!name) return `Joint ${index} (node ${nodeIndex})`
  const slot = humanoidSlotOf(name)
  return slot ? `${name}  ·  ${slot}` : name
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

export type AccessGroup = 'Built-in' | 'Self' | 'Parent' | 'Scene'
export interface AccessibleVariable {
  // Matches AnimationVariableBinding.nodeRef. The three keywords are RELATIONSHIPS, resolved every frame, and
  // are strongly preferred over a raw id: an id names an identity, and identities do not survive the
  // delete/re-add and asset-rebuild cycles that re-instantiate a placement.
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
 * What each built-in means, for the picker's tooltips. Kept here rather than in the engine because it is
 * purely authoring copy — the engine's NODE_BUILTINS owns the names and types, and this must not be able to
 * introduce one that does not exist.
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
 * Built-ins that can never be negative, mapped to the signed built-in to use instead (or undefined if there
 * is none). Vector magnitudes and elapsed times.
 *
 * Named explicitly because the constraint is invisible at the point of binding: `planarSpeed` reads like a
 * signed velocity and is not. A blend-space sample authored at a negative coordinate on an axis bound to one
 * of these sits where the probe can never travel, the gradient band gives it weight exactly 0 at every
 * reachable point, and its clip silently never plays — with nothing in the editor to say why.
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

/** Whether `requester` may bind to a class-script field of `access` declared on `owner`. Mirrors the legacy
 *  canAccessVariable rules — a script field's access modifier is only declared in the script, not on the node. */
function canAccessScriptField(access: string, owner: Node, requester: Node): boolean {
  if (access === 'public') return true
  if (requester === owner) return true
  if (access === 'protected') return requester.isDescendantOf(owner)
  return false // private, non-owner
}

/**
 * Enumerate the node variables the given source node may bind an animation parameter to, per the
 * access model: its own vars (Self), its parent's protected/public vars (Parent), and any other
 * scene node's public vars (Scene). Only number/boolean variables are usable as transition inputs.
 * Runs against the SOURCE node's real scene (the animation-editor clone is isolated).
 *
 * Two kinds of variable are offered: a class script's declared FIELDS (resolved from the node's linked
 * script asset — these are native properties on the node, not entries in the legacy `variables` Map), and
 * any remaining legacy inline-script variables. Underscore-prefixed script fields are internal and skipped.
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
    // Class-script fields first — the current model.
    for (const v of assetOf(owner)?.variables ?? []) {
      if (v.hidden || !usable(v.type)) continue
      if (owner !== requester && !canAccessScriptField(v.access, owner, requester)) continue
      seen.add(v.name)
      out.push({ nodeRef, group, nodeLabel: label, varName: v.name, varType: v.type as 'number' | 'boolean', source: 'variable' })
    }
    // Legacy inline-script variables (the old editor-created Map).
    for (const [name, v] of owner.variables) {
      if (name.startsWith('__') || seen.has(name) || !usable(v.type)) continue
      if (owner !== requester && !canAccessVariable(owner, requester, name)) continue
      out.push({ nodeRef, group, nodeLabel: label, varName: name, varType: v.type as 'number' | 'boolean', source: 'variable' })
    }
  }

  /**
   * Engine-measured values, offered for the same nodes the variables above are. They need no access check
   * and no script asset — they exist on every node — so they are listed first: for a locomotion machine
   * `planarSpeed` is almost always the right answer, and it needs no script to be written at all.
   *
   * Offered for Self, Parent, and — crucially — the nearest ancestor that actually HAS A BODY. Every motion
   * built-in reads 0 on a bodyless node, and a character placed from a model asset is
   * `Playable(body) → holder → ModelNode(animator)`, so neither Self nor Parent is the thing that moves.
   * Without the bodied ancestor there is simply no way to reach the speed from the machine.
   *
   * Self and Parent are offered UNCONDITIONALLY, and it is a mistake to gate them on `node.body`: the editor
   * never calls `setBody`, so no node in the authoring scene has one. Physics is held in a side map and only
   * materialized when the scene is parsed for Play, which means gating on the live body hides every built-in
   * from the very screen they are authored on. `bodiedIds` is that side map's key set, which is why the
   * bodied-ancestor entry takes it rather than reading `node.body`.
   *
   * Not offered for every node in the scene: twenty entries each would bury the variables the user authored,
   * and no other node's speed is what this character animates to.
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
   * The nearest ancestor (or self) with a rigid body — whatever is actually being moved.
   *
   * Checks the authored set first and the live body second, so this resolves both while authoring (where only
   * the side map knows) and at runtime (where only the node does).
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
  // Stored as the RELATIONSHIP 'bodied', not as that node's id. An id is an identity, and identities do not
  // survive re-creation: deleting and re-adding a character, rebuilding a template instance or re-placing
  // from an asset all regenerate node ids, after which the binding names a node that no longer exists and
  // every built-in silently reads its default forever — a machine that poses its entry state correctly and
  // never transitions, with nothing anywhere saying why. 'bodied' resolves per frame to whatever is actually
  // moving, which is what this entry has always meant.
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
