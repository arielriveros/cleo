import { describe, it, expect } from 'vitest'
import { Scene, SequenceNode, parseSequence, markEditorOwned } from 'cleo'
import {
  buildSequenceAsset, detachSequence, firstNodeLinking, reembedSequences, sequenceIdsInScene, sequenceNodesOf,
  toRuntimeSequence, SEQUENCE_PREVIEW_NODE_NAME,
} from '../src/utils/sequenceAssets'
import { buildSceneRefs, collectReferencedSequenceIds } from '../src/utils/references'
import { resyncScene } from '../src/utils/sceneResync'

/**
 * The Sequence asset (`.sequence`): a named timeline, linked from a Sequence node, in the particle system's
 * embedded shape. A node plays its own COPY and `sequenceId` records where it came from, so:
 *  - a saved edit must reach the nodes holding an older copy (and only those that differ);
 *  - deleting the asset must leave every node's timeline playing;
 *  - the Sequencer's own preview node never counts as a link.
 */

const timeline = (duration: number) => parseSequence({ name: 'Tour', duration, slots: [], tracks: [], markers: [] })

function sceneWith(...nodes: SequenceNode[]): Scene {
  const scene = new Scene()
  for (const n of nodes) scene.addNode(n)
  return scene
}

describe('buildSequenceAsset', () => {
  it('starts empty, named after the asset', () => {
    const asset = buildSequenceAsset('Intro')
    expect(asset.name).toBe('Intro')
    expect(asset.sequence.name).toBe('Intro')
    expect(asset.sequence.tracks).toEqual([])
  })

  it('copies the timeline it is given rather than adopting it', () => {
    const source = timeline(12)
    const asset = buildSequenceAsset('Copy', source)
    asset.sequence.duration = 99
    expect(source.duration).toBe(12)
    expect(toRuntimeSequence(asset)).not.toBe(asset.sequence)
  })
})

describe('reembedSequences / detachSequence', () => {
  it('pushes a saved edit into the linked nodes that differ, and only those', () => {
    const asset = buildSequenceAsset('Tour', timeline(10))
    const linked = new SequenceNode('A', { sequence: timeline(5), sequenceId: asset.id })
    const same = new SequenceNode('B', { sequence: toRuntimeSequence(asset), sequenceId: asset.id })
    const loose = new SequenceNode('C', { sequence: timeline(5) })
    const scene = sceneWith(linked, same, loose)
    expect(reembedSequences(scene, [asset])).toBe(1)
    expect(linked.sequence.duration).toBe(10)
    expect(loose.sequence.duration).toBe(5)
    expect(reembedSequences(scene, [asset])).toBe(0)
  })

  it('unlinks on delete, keeping the timeline', () => {
    const node = new SequenceNode('A', { sequence: timeline(7), sequenceId: 'gone' })
    const scene = sceneWith(node)
    expect(detachSequence(scene, 'gone')).toBe(true)
    expect(node.sequenceId).toBeNull()
    expect(node.sequence.duration).toBe(7)
  })

  it('ignores the Sequencer\'s editor-owned preview node', () => {
    const asset = buildSequenceAsset('Tour', timeline(10))
    const preview = markEditorOwned(new SequenceNode(SEQUENCE_PREVIEW_NODE_NAME, { sequence: timeline(1) }))
    ;(preview as SequenceNode).sequenceId = asset.id
    const real = new SequenceNode('Real', { sequence: timeline(1), sequenceId: asset.id })
    const scene = sceneWith(preview as SequenceNode, real)
    expect(sequenceNodesOf(scene)).toEqual([real])
    expect(reembedSequences(scene, [asset])).toBe(1)
    expect((preview as SequenceNode).sequence.duration).toBe(1)
    expect([...sequenceIdsInScene(scene)]).toEqual([asset.id])
    expect([...collectReferencedSequenceIds(scene)]).toEqual([asset.id])
    expect(firstNodeLinking(scene, asset.id)).toBe(real)
  })
})

describe('scenes record and refresh their links', () => {
  it('a scene\'s refs list the sequences its nodes link', () => {
    const scene = sceneWith(new SequenceNode('A', { sequenceId: 'q1' }), new SequenceNode('B'))
    expect(buildSceneRefs(scene).sequenceIds).toEqual(['q1'])
  })

  it('opening a scene pulls the saved timeline, and drops a link to a deleted asset', () => {
    const asset = buildSequenceAsset('Tour', timeline(30))
    const stale = new SequenceNode('A', { sequence: timeline(3), sequenceId: asset.id })
    const orphan = new SequenceNode('B', { sequence: timeline(4), sequenceId: 'deleted' })
    const scene = sceneWith(stale, orphan)
    const maps = { scripts: new Map(), bodies: new Map(), triggers: new Map() }
    const changed = resyncScene(scene, maps, { materials: [], models: [], templates: [], terrainMaterials: [], scripts: [], sequences: [asset] }, undefined)
    expect(changed).toBe(true)
    expect(stale.sequence.duration).toBe(30)
    expect(orphan.sequenceId).toBeNull()
    expect(orphan.sequence.duration).toBe(4)
  })
})
