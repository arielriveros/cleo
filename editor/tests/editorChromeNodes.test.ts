import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CleoEngine, Node, Scene, SkyAtmosphereNode, SkyboxNode, markEditorOwned, isEditorOwnedName } from 'cleo'
import type { SceneChange } from 'cleo'
import { isEditorOwnedChange } from '../src/utils/editorOwned'
import { removeExistingSky } from '../src/features/sceneInspector/addCatalog'
import EventEmitter from '../src/utils/eventEmitter'

/**
 * The editor chrome three viewport tools park in the scene — the clip tab's bone-gizmo proxy and the two
 * brush cursors — plus the Add catalog's one-sky rule, which used to reach an asset tab's preview sky.
 *
 * None of these may ever mark a tab unsaved or become an undo step. The components are React and GL, so
 * their half is pinned as source contracts (the style of gizmoContract.test.ts); everything that runs
 * headless is exercised for real.
 */

const read = (rel: string) => readFileSync(join(__dirname, '../src/features', rel), 'utf8')
const BONE_GIZMO = read('clip/BoneGizmo.tsx')
const LANDSCAPE_BRUSH = read('landscape/LandscapeBrush.tsx')
// The landscape cursor's lifecycle moved out of the component into BrushCursor when the ring became a decal;
// the contracts below follow it there, and the component is held to disposing it.
const BRUSH_CURSOR = read('landscape/brushCursor.ts')
const TILEMAP_BRUSH = read('tilemap/TilemapBrush.tsx')

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

describe('the bone gizmo proxy', () => {
  const name = /const BONE_GIZMO_PROXY_NAME = '([^']+)'/.exec(BONE_GIZMO)?.[1] ?? ''

  it('is named as editor chrome', () => {
    // Unprefixed, every per-frame park on the selected joint marked the clip tab unsaved.
    expect(name).toBe('__editor__boneGizmoProxy')
    expect(isEditorOwnedName(name)).toBe(true)
    expect(BONE_GIZMO).not.toMatch(/['"]__boneGizmoProxy['"]/)
  })

  it('stays unpickable: no lowercase `gizmo`, which is the raycaster\'s exception for handles', () => {
    // Raycaster.raycast skips `__editor__` names unless they contain lowercase `gizmo`.
    expect(name.startsWith('__editor__') && !name.includes('gizmo')).toBe(true)
  })

  it('emits only owned events when added and removed, and nothing at all when parked on a joint', () => {
    const scene = newScene()
    const proxy = markEditorOwned(new Node(name))
    const added = capture(() => scene.addNode(proxy))
    expect(added.length).toBeGreaterThan(0)
    expect(added.every(isEditorOwnedChange)).toBe(true)
    // The rAF sync loop writes these every frame while a joint is selected.
    expect(capture(() => {
      proxy.setPosition([1, 2, 3])
      proxy.setQuaternion([0, 0, 0, 1])
    })).toEqual([])
    const removed = capture(() => scene.removeNode(proxy))
    expect(removed.length).toBeGreaterThan(0)
    expect(removed.every(isEditorOwnedChange)).toBe(true)
    expect(proxy.parent).toBe(null)
  })

  it('is added and removed synchronously inside withoutDirty, never through remove()', () => {
    // remove() despawns now and leaves the detach to Scene.update's sweep, a frame later and outside any
    // bracket, where it lands as a 'Delete' undo step.
    expect(code(BONE_GIZMO)).not.toMatch(/\.remove\(\)/)
    for (const token of ['editorScene.addNode(', 'editorScene.removeNode('])
      for (const at of occurrences(BONE_GIZMO, token))
        expect(insideWithoutDirty(BONE_GIZMO, at), `${token} at index ${at}`).toBe(true)
  })

  it('never goes into the game scene while a restored clip tab is still building its own', () => {
    expect(BONE_GIZMO).toMatch(/if \(!editorScene \|\| editorScene === mainScene\) return/)
  })
})

describe.each([
  ['LandscapeBrush', BRUSH_CURSOR, '__editor__terrainBrush'],
  ['TilemapBrush', TILEMAP_BRUSH, '__editor__tilemapCursor'],
])('the %s cursor', (_label, source, cursorName) => {
  it('is named as editor chrome', () => {
    expect(source).toContain(`'${cursorName}'`)
    expect(isEditorOwnedName(cursorName)).toBe(true)
  })

  it('builds, swaps and removes the cursor inside withoutDirty, never through remove()', () => {
    expect(code(source)).not.toMatch(/\.remove\(\)/)
    for (const token of ['editorScene.addNode(', 'editorScene.removeNode('])
      for (const at of occurrences(source, token))
        expect(insideWithoutDirty(source, at), `${token} at index ${at}`).toBe(true)
  })

  it('writes `visible` only inside withoutDirty, behind a change gate', () => {
    // `visible` is an unconditional structural emit; the hover path used to write it on every mousemove.
    for (const at of occurrences(source, '.visible = '))
      expect(insideWithoutDirty(source, at), `.visible = at index ${at}`).toBe(true)
    expect(source).toMatch(/if \(\w+\.visible !== shown\) withoutDirty\(/)
  })

  it('rebuilds a cursor stranded by a root swap', () => {
    // openScene parses INTO the same Scene object and replaces its root.
    expect(source).toMatch(/isUnder\(current, editorScene\.root\)/)
  })

  it('removes the cursor on unmount', () => {
    if (source === BRUSH_CURSOR) {
      // dispose() removes it under withoutDirty, and the brush component disposes it when its scene effect
      // is torn down — on unmount, and when the scene changes under it.
      expect(source).toMatch(/dispose\(\): void \{[\s\S]{0,300}?withoutDirty\(\(\) => editorScene\.removeNode\(/)
      expect(LANDSCAPE_BRUSH).toMatch(/useEffect\(\(\) => \{\s*if \(!editorScene\) return;?[\s\S]{0,300}?return \(\) => \{[\s\S]{0,200}?\.dispose\(\);/)
      return
    }
    expect(source).toMatch(/useEffect\(\(\) => \{\s*if \(!editorScene\) return;?\s*return \(\) => \{[\s\S]{0,200}?withoutDirty\(\(\) => editorScene\.removeNode\(/)
  })
})

describe('a landscape stroke', () => {
  it('marks the tab unsaved once, on release, and only if it changed the terrain', () => {
    // Height, splat and foliage writes emit nothing; before this the only SCENE_CHANGED during a stroke came
    // from the cursor, which is chrome and ignored — so sculpting never made the scene unsaved.
    expect(LANDSCAPE_BRUSH).toMatch(/if \(strokeEditedRef\.current\) eventEmitter\.emit\('SCENE_CHANGED'\);/)
    const ops = ['sculptWith', 'paintLayerMask', 'clearLayersAt', 'scatterFoliageFromMaterials', 'eraseAllFoliage', 'eraseFoliageExcept']
    let seen = 0
    for (const op of ops)
      for (const at of occurrences(LANDSCAPE_BRUSH, `terrain.${op}(`)) {
        seen++
        // Everything on the line before the call: `edited(`, optionally through the stroke's region recorder.
        const lead = LANDSCAPE_BRUSH.slice(LANDSCAPE_BRUSH.lastIndexOf('\n', at) + 1, at)
        expect(lead, `${op} at index ${at}`).toMatch(/edited\((record(Heights|Masks)\()?(h\.node\.)?$/)
      }
    // Not vacuous: every op is really called.
    expect(seen).toBeGreaterThanOrEqual(ops.length)
  })

  it('closes an open stroke when the tool unmounts mid-drag', () => {
    // The cleanup may detach other listeners and explain itself first; what matters is that the last
    // thing it does is close the stroke.
    expect(LANDSCAPE_BRUSH).toMatch(/window\.removeEventListener\('mouseup', onUp\);[\s\S]{0,800}?onUp\(\);\s*\};/)
  })
})

describe('the tilemap stroke', () => {
  it('still records its hand-built undo step and marks the tab dirty — those are real edits', () => {
    expect(TILEMAP_BRUSH).toMatch(/push\(\{\s*label: stroke\.label,/)
    expect(TILEMAP_BRUSH).toContain("eventEmitter.emit('SCENE_CHANGED')")
  })
})

describe('removeExistingSky', () => {
  const ctxFor = (scene: Scene) => {
    const eventEmitter = new EventEmitter()
    let emits = 0
    eventEmitter.on('SCENE_CHANGED', () => { emits++ })
    return { ctx: { editorScene: scene, eventEmitter }, emits: () => emits }
  }
  // A Skybox needs a GL cubemap; the node itself does not, and removeExistingSky only reads the node.
  const skyboxNode = (name: string) => new SkyboxNode(name, null as any)

  it('leaves an asset tab\'s preview sky alone when a Sky Atmosphere is added', () => {
    const scene = newScene()
    const preview = skyboxNode('__editor__skybox')
    scene.addNode(preview)
    const { ctx, emits } = ctxFor(scene)
    removeExistingSky(ctx, 'skyAtmosphere')
    expect(preview.parent).toBe(scene.root)
    expect(emits()).toBe(0)
  })

  it('still replaces the user\'s own skybox, even when a preview sky is also present', () => {
    // scene.skybox is just the LAST SkyboxNode the traversal met, so with both present the old code could
    // pick either one.
    const scene = newScene()
    const user = skyboxNode('skybox')
    const preview = skyboxNode('__editor__skybox')
    scene.addNode(user)
    scene.addNode(preview)
    const { ctx, emits } = ctxFor(scene)
    removeExistingSky(ctx, 'skyAtmosphere')
    expect(user.parent).toBe(null)
    expect(preview.parent).toBe(scene.root)
    expect(emits()).toBe(1)
  })

  it('replaces the user\'s Sky Atmosphere when a Skybox is added, but not an owned one', () => {
    const scene = newScene()
    const user = new SkyAtmosphereNode('sky atmosphere')
    const owned = markEditorOwned(new SkyAtmosphereNode('preview atmosphere'))
    scene.addNode(user)
    scene.addNode(owned)
    const { ctx, emits } = ctxFor(scene)
    removeExistingSky(ctx, 'skybox')
    expect(user.parent).toBe(null)
    expect(owned.parent).toBe(scene.root)
    expect(emits()).toBe(1)
  })

  it('does nothing, and emits nothing, when there is no sky of the other kind', () => {
    const scene = newScene()
    const user = skyboxNode('skybox')
    scene.addNode(user)
    const { ctx, emits } = ctxFor(scene)
    removeExistingSky(ctx, 'skybox')
    expect(user.parent).toBe(scene.root)
    expect(emits()).toBe(0)
  })
})

/** `source` without its comments, which are free to name the calls the code must not make. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Every index at which `token` starts in `source`. */
function occurrences(source: string, token: string): number[] {
  const out: number[] = []
  for (let at = source.indexOf(token); at !== -1; at = source.indexOf(token, at + 1)) out.push(at)
  expect(out.length, `${token} should appear at least once`).toBeGreaterThan(0)
  return out
}

/**
 * True when `index` falls inside the argument list of some `withoutDirty(` call. Brace-matched rather than
 * line-matched, so a multi-line callback counts. Same helper as gizmoContract.test.ts.
 */
function insideWithoutDirty(source: string, index: number): boolean {
  for (let at = source.indexOf('withoutDirty('); at !== -1; at = source.indexOf('withoutDirty(', at + 1)) {
    const open = source.indexOf('(', at)
    let depth = 0
    for (let i = open; i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') {
        depth--
        if (depth === 0) {
          if (index > open && index < i) return true
          break
        }
      }
    }
  }
  return false
}
