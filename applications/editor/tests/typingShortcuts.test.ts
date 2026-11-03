import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isStolenTreeFocus, TREE_GESTURE_MS } from '../src/utils/treeFocusGuard'

// Typing in a field or the code editor keeps its letters, and the editor's letter shortcuts stay out of
// it. Source-text checks where the code pulls in the engine and React (see editorModeReachability.test.ts),
// and the tree guard's decision directly.

const SRC = join(__dirname, '..', 'src')
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf-8').replace(/\r\n/g, '\n')

describe('the game hands the keyboard back on Stop', () => {
  it('preventDefault is owned by the play-state handler and switched off on stop', () => {
    const ctx = read('features', 'EngineContext.tsx')
    // Left on after the first Play, every field lost W A S D Q E, Enter, Escape and the arrows.
    const stop = ctx.slice(ctx.indexOf("else if (state === 'stop')"), ctx.indexOf("eventEmitter.current.on('SELECT_NODE'"))
    expect(stop).toContain('InputSystem.instance.preventDefault = false')
    expect(ctx).toContain('InputSystem.instance.preventDefault = !simulate')
    const start = ctx.slice(ctx.indexOf('const startSession = async'), ctx.indexOf('const stopPlay = () =>'))
    expect(start).not.toContain('preventDefault')
  })
})

describe('letter shortcuts leave typing alone', () => {
  const HANDLERS = [
    ['features', 'gizmo', 'useGizmoShortcuts.ts'],
    ['features', 'Editor.tsx'],
    ['features', 'gizmo', 'CollisionGizmo.tsx'],
    ['features', 'landscape', 'LandscapeBrush.tsx'],
    ['features', 'models', 'ClothBrush.tsx'],
    ['features', 'tilemap', 'TilemapBrush.tsx'],
  ]

  it('every handler asks the one shared predicate, which knows about the code editor', () => {
    for (const path of HANDLERS) {
      const src = read(...path)
      expect(src, path.join('/')).toContain('isTextEntryEvent(e')
      expect(src, path.join('/')).not.toMatch(/\^\(INPUT\|TEXTAREA\|SELECT\)\$/)
      expect(src, path.join('/')).not.toMatch(/tagName === 'INPUT'/)
    }
    const creator = readFileSync(join(__dirname, '..', '..', 'creator', 'src', 'app', 'workspace.tsx'), 'utf-8')
    expect(creator).toContain('isTextEntryEvent(e)')
  })

  it('W / E / R / X wait while a mouse button is held, since W and E also fly the camera', () => {
    const hook = read('features', 'gizmo', 'useGizmoShortcuts.ts')
    expect(hook).toContain('if (isTextEntryEvent(e) || buttonsRef.current) return;')
    expect(hook).toContain("window.addEventListener('mousedown', trackButtons, true)")
    expect(hook).toContain("window.addEventListener('mouseup', trackButtons, true)")
  })
})

describe('a tree row never takes the keyboard from a field', () => {
  it('both arborist trees install the guard', () => {
    expect(read('features', 'sceneInspector', 'SceneInspector.tsx')).toContain('useTreeFocusGuard(viewportEl, treeRef)')
    expect(read('features', 'animation', 'SkeletonTree.tsx')).toContain('useTreeFocusGuard(viewportEl, treeRef)')
  })

  it('refuses a row taking focus from outside with nothing pressed in the tree', () => {
    const late = TREE_GESTURE_MS + 1
    // Abandoning a rename by clicking into another field: arborist re-focuses the row a tick later.
    expect(isStolenTreeFocus({ isRow: true, fromInside: false, sinceGestureMs: Infinity })).toBe(true)
    expect(isStolenTreeFocus({ isRow: true, fromInside: false, sinceGestureMs: late })).toBe(true)
  })

  it('allows what the user asked for', () => {
    // A click on a row, wherever focus was.
    expect(isStolenTreeFocus({ isRow: true, fromInside: false, sinceGestureMs: 0 })).toBe(false)
    // Arrow keys, Enter after a rename: focus moving within the tree.
    expect(isStolenTreeFocus({ isRow: true, fromInside: true, sinceGestureMs: Infinity })).toBe(false)
    // The rename field opening inside a row, or Tab landing on the tree's container.
    expect(isStolenTreeFocus({ isRow: false, fromInside: false, sinceGestureMs: Infinity })).toBe(false)
  })
})
