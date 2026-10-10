import { describe, it, expect } from 'vitest'
import { ParticleSystemNode, Scene, defaultParticleSystem } from 'cleo'
import {
  buildParticleSystemAsset, detachParticleSystem, particleSystemIdsInScene, reembedParticleSystems, toRuntimeSystem,
} from '../src/utils/particleSystems'

/**
 * The Particle System asset (`.vfx`): a named effect, linked from a ParticleSystemNode.
 *
 * The brain shape — the node keeps a full EMBEDDED copy of what it plays, and `particleSystemId` only
 * records where it came from. The same two risks, pinned the same way:
 *
 *  - an edited asset has to reach nodes already holding a stale copy (and ONLY those that differ —
 *    `setSystem` restarts the effect, so a no-op re-embed would visibly reset every emitter), and
 *  - deleting an asset must not blank the effects that used it.
 */

function sceneWith(...nodes: ParticleSystemNode[]): Scene {
  const scene = new Scene()
  for (const n of nodes) scene.addNode(n)
  return scene
}

describe('buildParticleSystemAsset', () => {
  it('starts from the default effect when given none', () => {
    const asset = buildParticleSystemAsset()
    expect(asset.name).toBe('New Particle System')
    expect(asset.system.emitters.length).toBeGreaterThan(0)
  })

  it('copies the system it is given rather than adopting it', () => {
    const source = defaultParticleSystem()
    const asset = buildParticleSystemAsset('Fire', source)
    asset.system.emitters[0].name = 'changed'
    expect(source.emitters[0].name).not.toBe('changed')
  })
})

describe('toRuntimeSystem', () => {
  it('returns a parsed copy that shares nothing with the library record', () => {
    const asset = buildParticleSystemAsset('Fire')
    const runtime = toRuntimeSystem(asset)
    expect(runtime).toEqual(asset.system)
    expect(runtime).not.toBe(asset.system)
  })
})

describe('reembedParticleSystems', () => {
  it('pushes an edited asset into linked nodes and counts them', () => {
    const asset = buildParticleSystemAsset('Fire')
    const linked = new ParticleSystemNode('a', { system: asset.system, particleSystemId: asset.id })
    const other = new ParticleSystemNode('b', { system: asset.system })
    const scene = sceneWith(linked, other)

    asset.system.emitters[0].capacity = 64
    expect(reembedParticleSystems(scene, [asset])).toBe(1)
    expect(linked.system.emitters[0].capacity).toBe(64)
    expect(other.system.emitters[0].capacity).not.toBe(64)
  })

  it('leaves an identical copy alone — re-assigning would restart the effect', () => {
    const asset = buildParticleSystemAsset('Fire')
    const node = new ParticleSystemNode('a', { system: asset.system, particleSystemId: asset.id })
    const before = node.version
    expect(reembedParticleSystems(sceneWith(node), [asset])).toBe(0)
    expect(node.version).toBe(before)
  })

  it('tolerates no scene at all', () => {
    expect(reembedParticleSystems(null, [])).toBe(0)
  })
})

describe('detachParticleSystem', () => {
  it('drops the link but keeps the embedded effect playing', () => {
    const asset = buildParticleSystemAsset('Fire')
    const node = new ParticleSystemNode('a', { system: asset.system, particleSystemId: asset.id })
    const scene = sceneWith(node)
    expect(detachParticleSystem(scene, asset.id)).toBe(true)
    expect(node.particleSystemId).toBeNull()
    expect(node.system.emitters.length).toBe(asset.system.emitters.length)
    expect(detachParticleSystem(scene, asset.id)).toBe(false)
  })
})

describe('particleSystemIdsInScene', () => {
  it('collects each linked asset once', () => {
    const a = new ParticleSystemNode('a', { particleSystemId: 'fire' })
    const b = new ParticleSystemNode('b', { particleSystemId: 'fire' })
    const c = new ParticleSystemNode('c', { particleSystemId: 'smoke' })
    const d = new ParticleSystemNode('d')
    expect([...particleSystemIdsInScene(sceneWith(a, b, c, d))].sort()).toEqual(['fire', 'smoke'])
  })
})
