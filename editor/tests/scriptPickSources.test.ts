import { describe, it, expect } from 'vitest'
import { Node, SoundNode } from 'cleo'
import { pickChoices, type PickContext } from '../src/features/nodeInspector/scriptEditor/pickSources'

// Where a typed name field's dropdown gets its names: from the node's surroundings, the way the script
// resolves them at runtime (an attack plays its enemy's cues; a move names its sibling moves).

const ctx = (over: Partial<PickContext> = {}): PickContext => ({ sceneRoot: null, rigs: [], animations: [], templates: [], ...over })

function enemy() {
  const root = new Node('Hollow')
  const sounds = new Node('Sounds')
  sounds.addChild(new SoundNode('Enemy Swing', { mode: 'spatial' }))
  sounds.addChild(new SoundNode('Stagger', { mode: 'spatial' }))
  sounds.addChild(new Node('not a sound'))
  root.addChild(sounds)
  const attacks = new Node('Attacks')
  const swing = new Node('Swing')
  const sweep = new Node('Sweep')
  attacks.addChild(swing)
  attacks.addChild(sweep)
  root.addChild(attacks)
  return { root, swing }
}

describe('pickChoices', () => {
  it('offers the cues of the nearest Sounds group above, and only SoundNodes', () => {
    const { swing } = enemy()
    expect(pickChoices('sound', swing, ctx()).map(c => c.value)).toEqual(['Enemy Swing', 'Stagger'])
  })

  it('offers the nodes inside and beside a node', () => {
    const { swing } = enemy()
    swing.addChild(new Node('Trail'))
    expect(pickChoices('node', swing, ctx())).toEqual([
      { value: 'Trail', group: 'Inside' },
      { value: 'Sweep', group: 'Beside' },
    ])
  })

  it('offers every template by name', () => {
    const { swing } = enemy()
    const templates = [{ id: 'a', name: 'Magic Bolt' }, { id: 'b', name: 'Slam Dust' }] as any
    expect(pickChoices('template', swing, ctx({ templates })).map(c => c.value)).toEqual(['Magic Bolt', 'Slam Dust'])
  })

  it('falls back to every clip grouped by rig when no character is above', () => {
    const { swing } = enemy()
    const animations = [
      { id: 'a1', name: 'Combat', rigId: 'r1', clips: [{ name: 'Souls_Sword_L1' }, { name: 'Souls_Roll' }] },
      { id: 'a2', name: 'Loose', clips: [{ name: 'Wave' }] },
    ] as any
    const rigs = [{ id: 'r1', name: 'Mannequin', animationIds: [] }] as any
    expect(pickChoices('clip', swing, ctx({ animations, rigs }))).toEqual([
      { value: 'Souls_Sword_L1', group: 'Mannequin' },
      { value: 'Souls_Roll', group: 'Mannequin' },
      { value: 'Wave', group: 'Other clips' },
    ])
  })

  it('stops the owner walk below the scene root', () => {
    const scene = new Node('root')
    const sounds = new Node('Sounds')
    sounds.addChild(new SoundNode('Ambience', { mode: 'spatial' }))
    scene.addChild(sounds)
    const lever = new Node('Lever')
    scene.addChild(lever)
    // A level-wide Sounds group is still found (the GameManager's cues), matching SoulsAudio.soundOf.
    expect(pickChoices('sound', lever, ctx({ sceneRoot: scene })).map(c => c.value)).toEqual(['Ambience'])
    expect(pickChoices('socket', lever, ctx({ sceneRoot: scene }))).toEqual([])
  })
})
