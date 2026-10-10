import { cloneParticleSystem, defaultParticleSystem, parseParticleSystem } from 'cleo'
import type { ParticleSystemDef, ParticleSystemNode, Scene } from 'cleo'
import { cryptoRandomId } from './ids'

/**
 * A PARTICLE SYSTEM asset (`.vfx`): a named, reusable effect — a list of emitters, each a module stack
 * plus one renderer. The schema itself is the engine's `ParticleSystemDef`; this record only gives it an
 * id and a name so the library, the explorer and scene nodes can address it.
 *
 * ## Embedded, not referenced
 *
 * `ParticleSystemNode.system` stays the runtime source of truth — the node keeps a full copy and
 * `particleSystemId` records where it came from. Same model as AI brains and tilesets, for the same two
 * reasons: the renderer needs no registry lookup per node, and a published game ships nothing extra
 * because the copy rides inside the serialized scene. {@link reembedParticleSystems} is what carries an
 * edit back out to nodes that already hold a stale copy.
 */
export interface ParticleSystemAsset {
  id: string
  name: string
  system: ParticleSystemDef
  thumbnail?: string
}

/**
 * Name of the editor-owned node the particle tab plays the asset through.
 *
 * Deliberately WITHOUT a `__editor__` marker: ownership comes from `markEditorOwned` (the flag form of
 * `Node.isEditorOwned`), which is enough to keep it out of saves, undo and dirty tracking. A name marker
 * would also hide it from the Scene panel, which filters on names, and seeing the preview node there is
 * harmless. Nothing serializes the preview scene anyway.
 */
export const PARTICLE_PREVIEW_NODE_NAME = '__particle_preview'

/**
 * A new asset. `system` is COPIED, never adopted — the caller usually passes a node's live definition
 * (the "create asset from this effect" path), and sharing that object would let later edits to the
 * library leak into the node without going through `setSystem`.
 */
export function buildParticleSystemAsset(name = 'New Particle System', system?: ParticleSystemDef): ParticleSystemAsset {
  return {
    id: cryptoRandomId(),
    name,
    system: system ? cloneParticleSystem(system) : defaultParticleSystem(),
  }
}

/**
 * A stored asset read back through the engine's tolerant parser.
 *
 * Every copy crossing into a node goes through here: the parser is what drops an unknown module, fills a
 * missing param and clamps a capacity, so an asset from an older build or a hand-edited bundle can never
 * hand the GPU an emitter it cannot run. Cloned first so the result shares nothing with the library.
 */
export function toRuntimeSystem(asset: ParticleSystemAsset): ParticleSystemDef {
  return parseParticleSystem(cloneParticleSystem(asset.system))
}

function particleNodesOf(scene: Scene | null | undefined): ParticleSystemNode[] {
  if (!scene) return []
  return Array.from(scene.particleSystems ?? [])
}

/**
 * Push the current library into every particle node in a live scene, so an edited effect reaches nodes
 * that already embedded an older copy. Returns how many nodes changed, so the caller can skip a save.
 *
 * Compared by serialized value rather than by identity: `setSystem` discards live particles and
 * restarts the effect, so re-assigning an identical definition on every save would visibly reset every
 * emitter in the level — and mark its scene dirty for nothing.
 */
export function reembedParticleSystems(scene: Scene | null | undefined, assets: ParticleSystemAsset[]): number {
  let count = 0
  for (const node of particleNodesOf(scene)) {
    const id = node.particleSystemId
    if (!id) continue
    const asset = assets.find(a => a.id === id)
    if (!asset) continue
    const next = toRuntimeSystem(asset)
    if (JSON.stringify(node.system) === JSON.stringify(next)) continue
    node.setSystem(next)
    count++
  }
  return count
}

/**
 * Clear every reference to a deleted asset.
 *
 * The embedded copy is deliberately LEFT in place, as with brains: deleting a library entry should not
 * silently blank every fire and spark in the level. The node keeps playing what it was playing; it just
 * no longer claims to come from an asset that is gone.
 */
export function detachParticleSystem(scene: Scene | null | undefined, id: string): boolean {
  let changed = false
  for (const node of particleNodesOf(scene)) {
    if (node.particleSystemId !== id) continue
    node.particleSystemId = null
    changed = true
  }
  return changed
}

/** Particle-system ASSET ids a live scene references. */
export function particleSystemIdsInScene(scene: Scene | null | undefined): Set<string> {
  const ids = new Set<string>()
  for (const node of particleNodesOf(scene)) {
    if (node.particleSystemId) ids.add(node.particleSystemId)
  }
  return ids
}
