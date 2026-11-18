import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_EDITOR_PREFS, parseEditorPrefs } from '../src/features/options/editorPrefs'

// Play and the browser's keys. A game that walks on Ctrl and W closed the tab: Chrome keeps Ctrl+W, Ctrl+T and Ctrl+N
// from a page outside fullscreen. So Play offers fullscreen (where the input system takes every key with the
// Keyboard Lock), asks before a tab closes while a game plays, and lets the mouse go on a key of the editor's
// choosing, Esc unless changed. Source-text checks where the code is React with the engine behind it.

const SRC = join(__dirname, '..', 'src')
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf-8').replace(/\r\n/g, '\n')

describe('Play and the browser’s keys', () => {
  it('stores the release-mouse key, Esc by default, and refuses anything that is not a key code', () => {
    expect(DEFAULT_EDITOR_PREFS.releaseMouseKey).toBe('Escape')
    expect(parseEditorPrefs({}).releaseMouseKey).toBe('Escape')
    expect(parseEditorPrefs({ releaseMouseKey: 'Backquote' }).releaseMouseKey).toBe('Backquote')
    expect(parseEditorPrefs({ releaseMouseKey: 'F1' }).releaseMouseKey).toBe('F1')
    for (const bad of ['', '`', 'Key W', 42, null, 'x'.repeat(40)])
      expect(parseEditorPrefs({ releaseMouseKey: bad }).releaseMouseKey, String(bad)).toBe('Escape')
  })

  it('hands the key to the input system, live, and lets UI/Cancel free the mouse only while it is Esc', () => {
    const ctx = read('features', 'EngineContext.tsx')
    expect(ctx).toContain('InputSystem.instance.releaseKey = getEditorPrefs().releaseMouseKey;')
    expect(ctx).toMatch(/const sync = \(\) => \{ InputSystem\.instance\.releaseKey = getEditorPrefs\(\)\.releaseMouseKey; \};\s+sync\(\);\s+return editorPrefsStore\.subscribe\(sync\);/)
    expect(ctx).toContain("if (state.started && getEditorPrefs().releaseMouseKey === 'Escape') InputSystem.instance.releasePointerLock();")
    // The window a game plays in reads the same key.
    expect(read('player', 'session.tsx')).toContain('handle.engine.input.releaseKey = editorReleaseKey();')
  })

  it('asks before a tab closes while a game plays in the browser', () => {
    const ctx = read('features', 'EngineContext.tsx')
    expect(ctx).toContain('const playingInBrowser = isPlayMode && !isSimulating && !getShellBridge();')
    expect(ctx).toContain('const blocksUnload = hasUnsavedWork || playingInBrowser;')
    expect(ctx).toMatch(/if \(!blocksUnload\) return;/)
    expect(ctx).toContain('}, [blocksUnload]);')
  })

  it('offers fullscreen in Play, on the web, as an icon', () => {
    const viewport = read('features', 'EngineViewport.tsx')
    expect(viewport).toContain('{isPlayMode && !isSimulating && canPlayFullscreen() && <PlayFullscreenButton target={viewportRef} />}')
    const button = read('features', 'PlayFullscreenButton.tsx')
    expect(button).toContain("title={full ? 'Leave fullscreen (or hold Esc)' : 'Fullscreen: the game takes every key, browser shortcuts included'}")
    expect(button).toContain('!!document.fullscreenEnabled && !getShellBridge()')
    expect(button).toContain('<svg')
  })

  it('picks the key in Options ▸ Editor ▸ Viewport ▸ Play', () => {
    const options = read('features', 'options', 'EditorOptionsPanel.tsx')
    expect(options).toContain("<Section title='Play'>")
    expect(options).toContain('<ReleaseMouseKeyField />')
    expect(options).toContain("capture.start('releaseMouseKey', { device: 'key' })")
  })
})
