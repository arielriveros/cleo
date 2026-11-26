import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { publishedGraphics, publishedStartScene, shipsScene } from '../src/features/publish/publishChoices'

// Options ▸ Project ▸ Published game: the scenes a published game carries and the graphics API it runs on. The
// decisions are pure (publishChoices.ts); the second half pins that the build and the publish actually make them.

const read = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8')

describe('the scenes a published game carries', () => {
  it('starts in the main scene, or the first when the main one is gone', () => {
    expect(publishedStartScene(['a', 'b', 'c'], 'b')).toBe('b')
    expect(publishedStartScene(['a', 'b', 'c'], 'deleted')).toBe('a')
    expect(publishedStartScene([], 'a')).toBeUndefined()
  })

  it('ships every scene but the ones left out, and the start scene always', () => {
    const excluded = new Set(['menu', 'start'])
    expect(shipsScene('level', 'start', excluded)).toBe(true)
    expect(shipsScene('menu', 'start', excluded)).toBe(false)
    // Left out, but it is where the game starts: it ships.
    expect(shipsScene('start', 'start', excluded)).toBe(true)
  })
})

describe('the graphics API a published game runs on', () => {
  it('writes the chosen API, and nothing for a page that decides (Play in window)', () => {
    expect(publishedGraphics('webgpu', true)).toEqual({ backend: 'webgpu' })
    expect(publishedGraphics('webgl2', true)).toEqual({ backend: 'webgl2' })
    expect(publishedGraphics(undefined, true)).toEqual({})
  })

  it('drops the WebGL 2 shaders only for a game that does not run on WebGL 2', () => {
    expect(publishedGraphics('webgpu', false)).toEqual({ backend: 'webgpu', webgl2: false })
    // A WebGL 2 game always carries its shaders, whatever the fallback switch says.
    expect(publishedGraphics('webgl2', false)).toEqual({ backend: 'webgl2' })
  })
})

describe('the publish path', () => {
  it('builds with those decisions', () => {
    const build = read('src', 'features', 'publish', 'buildMultiSceneGameData.ts')
    expect(build).toContain('shipsScene(meta.id, startId, excluded)')
    expect(build).toContain('publishedGraphics(src.graphicsBackend')
  })

  it('publishes with the API the project chose, "same as the editor" read as the editor\'s own', () => {
    const menu = read('src', 'features', 'MenuBar.tsx')
    expect(menu).toMatch(/chosen === 'editor' \? readBackendPreference\(\) : chosen/)
    const call = menu.slice(menu.indexOf('buildMultiSceneGameData({'))
    expect(call.slice(0, call.indexOf('});'))).toContain('graphicsBackend')
  })

  it('boots the engine on the published API unless the page asks for another', () => {
    const boot = read('src', 'player', 'boot.tsx')
    expect(boot).toContain("graphics.webgl2 === false ? 'webgpu' : (options.graphicsBackend ?? graphics.backend)")
    // What it runs on reaches the console even with the Logger off.
    expect(boot).toContain('reportBackends(engine, backend)')
  })
})
