import { describe, it, expect } from 'vitest'
import { groupTabStrip, workspaceMembers, workspaceRigIdOf, type WorkspaceLibs, type WorkspaceTab } from '../src/utils/animationWorkspace'

// Every animation editor for one skeleton is shown as ONE document — the user should never have to know
// that the skeleton, its clips, its animator and its blend spaces are separate sessions underneath.

const libs: WorkspaceLibs = {
  rigs: [
    { id: 'hero', name: 'Hero', animationIds: ['walk'] },
    { id: 'mixamo', name: 'Mixamo', animationIds: [] },
    { id: 'wolf', name: 'Wolf', animationIds: ['walk'] },
  ],
  // The walk's keys were authored on the Mixamo skeleton; Hero and Wolf both link it.
  animations: [{ id: 'walk', rigId: 'mixamo' }, { id: 'orphan', rigId: 'mixamo' }],
  animationFields: [{ id: 'loco', rigId: 'hero' }],
}

const tab = (id: string, kind: string, extra: Partial<WorkspaceTab> = {}): WorkspaceTab => ({ id, kind, title: id, ...extra })

describe('workspaceRigIdOf', () => {
  it('keys a skeleton tab on itself and a blend space on its skeleton', () => {
    expect(workspaceRigIdOf(tab('a', 'rig', { rigId: 'hero' }), libs)).toBe('hero')
    expect(workspaceRigIdOf(tab('b', 'animationField', { animationFieldId: 'loco' }), libs)).toBe('hero')
  })

  it('keys an animator on the skeleton stamped when it opened', () => {
    expect(workspaceRigIdOf(tab('c', 'stateMachine', { workspaceRigId: 'wolf' }), libs)).toBe('wolf')
    expect(workspaceRigIdOf(tab('c', 'stateMachine'), libs)).toBeNull()
  })

  it('keys a clip on a skeleton that LINKS it, preferring one already open', () => {
    const walk = tab('d', 'animation', { animationId: 'walk' })
    expect(workspaceRigIdOf(walk, libs)).toBe('hero')
    expect(workspaceRigIdOf(walk, libs, new Set(['wolf']))).toBe('wolf')
  })

  it('falls back to the authoring skeleton for a clip nothing links', () => {
    expect(workspaceRigIdOf(tab('e', 'animation', { animationId: 'orphan' }), libs)).toBe('mixamo')
  })

  it('leaves other kinds alone', () => {
    expect(workspaceRigIdOf(tab('f', 'scene'), libs)).toBeNull()
  })
})

describe('groupTabStrip', () => {
  it('collapses one skeleton\'s parts onto one entry at the first part\'s position', () => {
    const tabs = [
      tab('scene', 'scene'),
      tab('anim', 'stateMachine', { workspaceRigId: 'wolf' }),
      tab('mat', 'material'),
      tab('clip', 'animation', { animationId: 'walk' }),
      tab('skel', 'rig', { rigId: 'wolf' }),
    ]
    expect(groupTabStrip(tabs, libs)).toEqual([
      { type: 'tab', tabId: 'scene' },
      // The clip joins Wolf (already open) rather than Hero (first linker).
      { type: 'workspace', rigId: 'wolf', title: 'Wolf', memberIds: ['anim', 'clip', 'skel'] },
      { type: 'tab', tabId: 'mat' },
    ])
  })

  it('keeps separate skeletons separate', () => {
    const tabs = [tab('a', 'rig', { rigId: 'hero' }), tab('b', 'rig', { rigId: 'wolf' })]
    expect(groupTabStrip(tabs, libs).map(e => e.type === 'workspace' && e.rigId)).toEqual(['hero', 'wolf'])
  })

  it('lists a workspace\'s members', () => {
    const tabs = [tab('a', 'rig', { rigId: 'hero' }), tab('b', 'animationField', { animationFieldId: 'loco' }), tab('c', 'scene')]
    expect(workspaceMembers(tabs, libs, 'hero').map(t => t.id)).toEqual(['a', 'b'])
  })
})
