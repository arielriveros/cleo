import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { playBlockedReason } from '../src/features/playWindow/playGate'

const SRC = join(__dirname, '..', 'src', 'features')
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf-8').replace(/\r\n/g, '\n')

describe('Play waits for the project to open', () => {
  const open = { sceneReady: true, openSceneId: 'scene-1', load: null }

  it('lets a game start once the project is open and nothing is loading', () => {
    expect(playBlockedReason(open)).toBeNull()
    // A finished load still on record is not a load.
    expect(playBlockedReason({ ...open, load: { title: 'Opening project', finished: true } })).toBeNull()
  })

  it('holds it while the project opens: the scene not parsed yet, or no scene id yet', () => {
    expect(playBlockedReason({ ...open, sceneReady: false })).toBe('The project is still opening')
    expect(playBlockedReason({ ...open, openSceneId: '' })).toBe('The project is still opening')
  })

  it('holds it while a scene opens or something imports, naming what', () => {
    expect(playBlockedReason({ ...open, load: { title: 'Opening "Crypt"', finished: false } }))
      .toBe('Opening "Crypt": Play is available once it is done')
    expect(playBlockedReason({ ...open, load: { title: 'Installing The Valley…', finished: false } }))
      .toBe('Installing The Valley: Play is available once it is done')
  })

  it('gates only starting a game in the menu bar; the engine refuses an early start from any caller', () => {
    const bar = read('MenuBar.tsx')
    expect(bar).toContain("const startBlocked = !!openingReason && !windowActive && playState === 'stopped'")
    expect(bar).toMatch(/const playDisabled = startBlocked \|\|/)
    expect(bar).toMatch(/disabled=\{startBlocked \|\| windowActive \|\| playState === 'simulating'/)
    const ctx = read('EngineContext.tsx')
    const start = ctx.slice(ctx.indexOf('const startSession = async'), ctx.indexOf('const startSession = async') + 2000)
    // After the resume path (a paused session resumes through startSession), before anything is built.
    expect(start.indexOf('if (!scenesLoadedRef.current || openingSceneRef.current)'))
      .toBeGreaterThan(start.indexOf("emit('SET_PLAY_STATE'"))
    const build = ctx.slice(ctx.indexOf('const buildWindowPlayData = async'), ctx.indexOf('const buildWindowPlayData = async') + 1200)
    expect(build).toContain('if (!scenesLoadedRef.current || !openSceneIdRef.current || openingSceneRef.current)')
  })
})
