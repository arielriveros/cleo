import { describe, it, expect, afterEach } from 'vitest'
import { CleoEngine, Node, Scene, markEditorOwned, parseNodeJson } from 'cleo'
import type { SceneChange } from 'cleo'
import { isEditorOwnedChange } from '../src/utils/editorOwned'
import { canSnapshot, structureEntry } from '../src/utils/historyRecording'

/**
 * What the editor's two user-edit trackers — the unsaved flag (EngineContext `mark`) and the undo recorder
 * (HistoryContext) — are allowed to see.
 *
 * The objects the editor puts into a scene for itself (the free-fly camera, gizmo handles, helper icons,
 * collider wireframes, brush cursors, preview props) are never the user's work. Before this, the unsaved flag
 * name-tested only the emitting node, and the recorder did not test at all. So the boot camera, the brush
 * cursors and the preview skyboxes all became undo steps, and undoing one deleted editor chrome.
 */

const scenes: Scene[] = []
const newScene = () => { const s = new Scene(); scenes.push(s); return s }
afterEach(() => { while (scenes.length) scenes.pop()!.dispose() })

function capture(run: () => void): SceneChange[] {
  const events: SceneChange[] = []
  const listener = (e: SceneChange) => events.push(e)
  CleoEngine.eventEmitter.on('SCENE_CHANGED', listener)
  try { run() } finally { CleoEngine.eventEmitter.off('SCENE_CHANGED', listener) }
  return events
}

/**
 * Every undo step the recorder would build from what `run` emits, judged against `scene`. Judged DURING the
 * dispatch, as the recorder does: the engine's ownership stamp is evaluated when read, against the tree as
 * it stands at that moment.
 */
function recorded(scene: Scene, run: () => void) {
  const steps: NonNullable<ReturnType<typeof structureEntry>>[] = []
  const listener = (e: SceneChange) => { const step = structureEntry(e, scene); if (step) steps.push(step) }
  CleoEngine.eventEmitter.on('SCENE_CHANGED', listener)
  try { run() } finally { CleoEngine.eventEmitter.off('SCENE_CHANGED', listener) }
  return steps
}

describe('isEditorOwnedChange', () => {
  it('trusts the engine stamp, which is the only correct answer for a removal', () => {
    const detached = new Node('shape') // no longer under its group, so asking the node would say "no"
    expect(isEditorOwnedChange({ kind: 'structure', node: detached, prop: 'remove', editorOwned: true })).toBe(true)
    expect(isEditorOwnedChange({ kind: 'structure', node: new Node('__editor__x'), editorOwned: false })).toBe(false)
  })

  it('asks the node when an editor-bus emit carries no stamp', () => {
    expect(isEditorOwnedChange({ kind: 'material', node: new Node('__debug__CameraModel') })).toBe(true)
    expect(isEditorOwnedChange({ kind: 'material', node: new Node('crate') })).toBe(false)
  })

  it('never classifies a payload-less "something changed" as owned', () => {
    // The Renderer panel and most inspectors mark the tab dirty exactly this way.
    expect(isEditorOwnedChange(undefined)).toBe(false)
    expect(isEditorOwnedChange({ kind: 'structure' })).toBe(false)
  })
})

describe('structureEntry', () => {
  it('records a user add, and its inverses round-trip', () => {
    const scene = newScene()
    const crate = new Node('crate')
    const [entry] = recorded(scene, () => scene.addNode(crate))
    expect(entry.label).toBe('Add crate')
    entry.undo()
    expect(crate.parent).toBe(null)
    entry.redo()
    expect(crate.parent).toBe(scene.root)
  })

  it('records nothing for the editor camera, gizmo handles or a brush cursor', () => {
    const scene = newScene()
    const handle = new Node('handle'); (handle as any).isGizmo = true
    const ring = new Node('ring'); ring.editorOnly = true
    expect(recorded(scene, () => {
      scene.addNode(new Node('__editor__Camera'))
      scene.addNode(handle)
      scene.addNode(ring)
      scene.removeNode(handle)
      scene.removeNode(ring)
    })).toEqual([])
  })

  it('records nothing for plain children of an owned group, including their removal', () => {
    const scene = newScene()
    const group = new Node('__debug__body_1')
    scene.addNode(group)
    const shape = new Node('shape')
    expect(recorded(scene, () => group.addChild(shape))).toEqual([])
    // The removal arrives after the shape has left the group; the stamp was computed before.
    expect(recorded(scene, () => group.removeChild(shape))).toEqual([])
  })

  it('records nothing inside a flagged preview holder', () => {
    const scene = newScene()
    const holder = markEditorOwned(new Node('Mannequin'))
    scene.addNode(holder)
    expect(recorded(scene, () => {
      const body = new Node('body')
      holder.addChild(body)
      body.despawn()
      body.spawn()
      holder.removeChild(body)
    })).toEqual([])
  })

  it('records nothing that happened in another scene, even when the ids collide', () => {
    // The play scene is parsed from the editor scene's own JSON, so its node ids are the editor's. Resolving a
    // parent by id alone bound those events to the EDITOR tree.
    const editor = newScene()
    const play = newScene()
    const twin = new Node('holder', 'node', 'shared-id')
    editor.addNode(new Node('holder', 'node', 'shared-id'))
    play.addNode(twin)
    expect(recorded(editor, () => {
      twin.addChild(new Node('bullet'))
      twin.despawn()
      play.removeNode(twin)
    })).toEqual([])
  })

  it('records a subtree being built only when it finally joins the scene', () => {
    const scene = newScene()
    const holder = new Node('prop')
    const steps = recorded(scene, () => {
      holder.addChild(new Node('part a'))
      holder.addChild(new Node('part b'))
      scene.addNode(holder)
    })
    expect(steps.map(s => s.label)).toEqual(['Add prop'])
  })

  it('records a delete, and restores the node where it was', () => {
    const scene = newScene()
    const a = new Node('a'), b = new Node('b'), c = new Node('c')
    scene.addNode(a); scene.addNode(b); scene.addNode(c)
    const [entry] = recorded(scene, () => scene.removeNode(b))
    expect(entry.label).toBe('Delete b')
    entry.undo()
    expect(scene.root.children.filter(n => ['a', 'b', 'c'].includes(n.name))).toEqual([a, b, c])
    entry.redo()
    expect(b.parent).toBe(null)
  })

  it('does nothing when replayed against a tree that has moved on', () => {
    const scene = newScene()
    const crate = new Node('crate')
    const [entry] = recorded(scene, () => scene.addNode(crate))
    // Something else re-parented the crate since. The step must not tear it out of its new home.
    const shelf = new Node('shelf')
    scene.addNode(shelf)
    shelf.addChild(crate)
    entry.undo()
    expect(crate.parent).toBe(shelf)
  })

  it('ignores the detach half of a move and editor-bus emits that carry no placement', () => {
    const scene = newScene()
    const a = new Node('a'), b = new Node('b')
    scene.addNode(a); scene.addNode(b)
    const steps = recorded(scene, () => b.addChild(a))
    expect(steps.map(s => s.label)).toEqual(['Move a'])
    expect(structureEntry({ kind: 'structure', node: a }, scene)).toBe(null)
  })
})

describe('canSnapshot', () => {
  it('baselines authored nodes of the tab scene only', () => {
    const scene = newScene()
    const crate = new Node('crate')
    scene.addNode(crate)
    expect(canSnapshot(crate, scene)).toBe(true)
    expect(canSnapshot(crate, newScene())).toBe(false)
  })

  it('never baselines the root, a detached node, or anything editor-owned', () => {
    const scene = newScene()
    expect(canSnapshot(scene.root, scene)).toBe(false)
    expect(canSnapshot(new Node('loose'), scene)).toBe(false)
    const holder = markEditorOwned(new Node('Mannequin'))
    scene.addNode(holder)
    const body = new Node('body')
    holder.addChild(body)
    expect(canSnapshot(holder, scene)).toBe(false)
    expect(canSnapshot(body, scene)).toBe(false)
    const camera = new Node('__editor__Camera')
    scene.addNode(camera)
    expect(canSnapshot(camera, scene)).toBe(false)
    expect(canSnapshot(null, scene)).toBe(false)
  })
})

/**
 * What HistoryContext.restore does to a node when a snapshot step is undone or redone: the live object is
 * detached and a NEW one is parsed in its place, under the same id.
 */
async function snapshotReplace(scene: Scene, node: Node): Promise<Node> {
  const json = await node.serialize()
  const parent = node.parent!
  const index = parent.children.indexOf(node)
  parent.removeChild(node, true)
  parseNodeJson(parent, json)
  const rebuilt = scene.getNodeById(json.id)!
  parent.moveChildTo(rebuilt, index)
  return rebuilt
}

const countId = (scene: Scene, id: string) => {
  let n = 0
  const walk = (x: Node) => { if (x.id === id) n++; x.children.forEach(walk) }
  walk(scene.root)
  return n
}

describe('structure steps after a snapshot step replaced the node', () => {
  // A snapshot undo rebuilds a node as a new object under the same id. A structure step that acted on the
  // object it captured then did nothing on undo, and on redo put a SECOND node with that id into the scene.
  it('undoes and redoes an add against the node that stands for the id now', async () => {
    const scene = newScene()
    const cube = new Node('cube')
    const [add] = recorded(scene, () => scene.addNode(cube))
    await snapshotReplace(scene, cube) // e.g. undoing a gizmo drag made after the add
    add.undo()
    expect(countId(scene, cube.id)).toBe(0)
    add.redo()
    expect(countId(scene, cube.id)).toBe(1)
  })

  it('never re-adds a node whose id is still in the tree', async () => {
    const scene = newScene()
    const cube = new Node('cube')
    const [add] = recorded(scene, () => scene.addNode(cube))
    add.undo()
    // Something else put a node with that id back in the meantime.
    scene.addNode(new Node('cube', 'node', cube.id))
    add.redo()
    expect(countId(scene, cube.id)).toBe(1)
  })

  it('re-deletes the replacement and restores a delete under the LIVE parent', async () => {
    const scene = newScene()
    const group = new Node('group')
    const child = new Node('child')
    scene.addNode(group)
    group.addChild(child)
    const [del] = recorded(scene, () => group.removeChild(child))
    const liveGroup = await snapshotReplace(scene, group) // the parent was edited and undone since
    del.undo()
    expect(child.parent).toBe(liveGroup)
    expect(countId(scene, child.id)).toBe(1)
    const liveChild = await snapshotReplace(scene, child)
    del.redo()
    expect(liveChild.parent).toBe(null)
    expect(countId(scene, child.id)).toBe(0)
  })

  it('moves back the node that is really there, never a stale copy stranded under a detached parent', async () => {
    const scene = newScene()
    const group = new Node('group')
    const child = new Node('child')
    scene.addNode(group)
    group.addChild(child)
    const [move] = recorded(scene, () => scene.root.addChild(child))
    move.undo()
    expect(child.parent).toBe(group)
    const liveGroup = await snapshotReplace(scene, group) // rebuilds the child too, as a new object
    move.redo()
    expect(countId(scene, child.id)).toBe(1)
    expect(scene.getNodeById(child.id)!.parent).toBe(scene.root)
    expect(liveGroup.children).toEqual([])
  })
})

describe('the scene root of a LOADED scene', () => {
  it('is never baselined, although Scene.parse leaves it parented to the wrapper it was parsed under', async () => {
    const source = newScene()
    source.addNode(new Node('crate'))
    const json = { scene: await source.root.serialize() }
    const scene = newScene()
    scene.parse(json, true)
    expect(scene.root.parent).not.toBe(null) // the premise: a parent test alone would let the root through
    expect(canSnapshot(scene.root, scene)).toBe(false)
    const crate = scene.root.children.find(n => n.name === 'crate')!
    expect(canSnapshot(crate, scene)).toBe(true)
  })
})
