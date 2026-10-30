import { ModelNode, AnimatedModel, ownedSoundsGroup, isEditorOwnedName, type Node } from 'cleo'
import { skinnedModelNodeOf } from '../../../utils/models'
import type { ScriptPickKind } from '../../../utils/scripts'
import type { AnimationAsset } from '../../../utils/animationAssets'
import type { RigAsset } from '../../../utils/rigAssets'
import type { Template } from '../../../utils/templates'

// Where a typed name field's choices come from (`clip: ClipName`, `sound: SoundName`, ... — see
// src/core/scripting/fieldTypes.ts). Every source reads the node's SURROUNDINGS the way the script will at
// runtime: the clips of the character the node belongs to, the cues of its nearest `Sounds` group, the
// sockets on its skeleton. The value stays a plain string, so a choice the list cannot see is still kept
// (the inspector flags it rather than dropping it).

/** One offered value, optionally under a group header (e.g. the rig a clip belongs to). */
export type PickChoice = { value: string; group?: string }

export type PickContext = {
  /** The scene the node lives in: owner walks stop BELOW its root, which would mean "the whole level". */
  sceneRoot: Node | null | undefined
  rigs: RigAsset[]
  animations: AnimationAsset[]
  templates: Template[]
}

const isHelper = (n: Node) => isEditorOwnedName(n.name)

/** `node` and its ancestors up to (not including) the scene root, nearest first. */
function ownersOf(node: Node, sceneRoot: Node | null | undefined): Node[] {
  const out: Node[] = []
  for (let a: Node | null = node; a && a !== sceneRoot && a.parent; a = a.parent) out.push(a)
  // A node with no parent at all (a template tab's own root) is still its own owner.
  if (!node.parent) out.push(node)
  return out
}

const unique = (choices: PickChoice[]): PickChoice[] => {
  const seen = new Set<string>()
  return choices.filter(c => {
    const key = `${c.group ?? ''}\u0000${c.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The skinned model of the character `node` belongs to: the nearest one at or under an ancestor. */
function ownerSkinnedModel(node: Node, ctx: PickContext): ModelNode | null {
  for (const a of ownersOf(node, ctx.sceneRoot)) {
    const found = skinnedModelNodeOf(a)
    if (found) return found
  }
  return null
}

/** Every clip in the project, grouped by the rig that plays it. */
function allClips(ctx: PickContext): PickChoice[] {
  const byId = new Map(ctx.animations.map(a => [a.id, a]))
  const out: PickChoice[] = []
  const placed = new Set<string>()
  for (const rig of ctx.rigs) {
    const ids = new Set([...(rig.animationIds ?? []), ...ctx.animations.filter(a => a.rigId === rig.id).map(a => a.id)])
    for (const id of ids) {
      const anim = byId.get(id)
      if (!anim) continue
      placed.add(id)
      for (const clip of anim.clips) out.push({ value: clip.name, group: rig.name })
    }
  }
  for (const anim of ctx.animations) {
    if (placed.has(anim.id)) continue
    for (const clip of anim.clips) out.push({ value: clip.name, group: 'Other clips' })
  }
  return out
}

function clipChoices(node: Node, ctx: PickContext): PickChoice[] {
  const model = ownerSkinnedModel(node, ctx)
  const live = model?.model instanceof AnimatedModel ? model.model.animations : null
  if (live?.length) {
    const group = modelOwnerName(model!)
    return live.map(a => ({ value: a.name, group }))
  }
  // No character above: a weapon's move, say, which is only put in a hand at runtime. Offer everything.
  return allClips(ctx)
}

/** The name to head a character's clips with: the model's holder (the template/instance), not "Mesh_0". */
function modelOwnerName(model: ModelNode): string {
  for (let a: Node | null = model; a; a = a.parent) {
    if (a.parent && !(a instanceof ModelNode)) return a.name
  }
  return model.name
}

function soundChoices(node: Node): PickChoice[] {
  const group = ownedSoundsGroup(node)
  if (!group) return []
  return group.children.filter(c => c.nodeType === 'sound' && !isHelper(c)).map(c => ({ value: c.name }))
}

function socketChoices(node: Node, ctx: PickContext): PickChoice[] {
  for (const a of ownersOf(node, ctx.sceneRoot)) {
    const names = new Set<string>()
    const queue: Node[] = [a]
    while (queue.length) {
      const n = queue.shift()!
      if (isHelper(n)) continue
      if (n instanceof ModelNode) n.socketNames.forEach(s => names.add(s))
      queue.push(...n.children)
    }
    if (names.size) return [...names].map(value => ({ value }))
  }
  return []
}

function nodeChoices(node: Node): PickChoice[] {
  const out: PickChoice[] = []
  const walk = (n: Node) => {
    for (const c of n.children) {
      if (isHelper(c)) continue
      out.push({ value: c.name, group: 'Inside' })
      walk(c)
    }
  }
  walk(node)
  for (const s of node.parent?.children ?? []) {
    if (s !== node && !isHelper(s)) out.push({ value: s.name, group: 'Beside' })
  }
  return out
}

/** The values a `pick` field of `kind` can take on `node`. Empty when there is nothing to offer. */
export function pickChoices(kind: ScriptPickKind, node: Node, ctx: PickContext): PickChoice[] {
  switch (kind) {
    case 'clip': return unique(clipChoices(node, ctx))
    case 'sound': return unique(soundChoices(node))
    case 'socket': return unique(socketChoices(node, ctx))
    case 'template': return unique(ctx.templates.map(t => ({ value: t.name })))
    case 'node': return unique(nodeChoices(node))
  }
}

/** Header text for a field's picker, e.g. "Clips of Player". */
export const PICK_LABEL: Record<ScriptPickKind, string> = {
  clip: 'clip', sound: 'sound cue', socket: 'socket', template: 'template', node: 'node',
}
