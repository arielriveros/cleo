import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Source-text checks, for the reason editorModeReachability.test.ts gives: DockLayout and EngineContext pull
// in dockview, the engine and a GL context, none of which a unit test can construct.
const read = (...p: string[]) => readFileSync(join(__dirname, '..', 'src', ...p), 'utf8')
const DOCK = () => read('features', 'layout', 'DockLayout.tsx')
const ENGINE = () => read('features', 'EngineContext.tsx')

describe('Simulate keeps the editor', () => {
  it('only Play strips the chrome', () => {
    expect(DOCK()).toMatch(/if \(playing && !simulating\) return \[\.\.\.CHROME_PANELS, \.\.\.OPTIONS_PANELS\]/)
  })

  it('docks the Engine options panel (Performance) while simulating', () => {
    const src = DOCK()
    expect(src).toMatch(/simulating \? OPTIONS_PANELS\.filter\(id => id !== 'optionsEngine'\)/)
    expect(src).toMatch(/if \(isSimulating && !api\.getPanel\('optionsEngine'\)/)
  })

  it('hides the Add palettes, which build into the authored scene', () => {
    expect(DOCK()).toMatch(/if \(simulating\) hide\(\.\.\.ADD_PANELS\)/)
  })

  it('publishes the running scene as inspectedScene, never as editorScene', () => {
    const src = ENGINE()
    expect(src).toMatch(/const inspectedScene = simulatedScene \?\? activeScene;/)
    expect(src).toMatch(/editorScene: activeScene,/)
    expect(src).toMatch(/setSimulatedScene\(null\);/)
  })

  it('keeps the editor camera map up when bindings change mid-Simulate', () => {
    expect(ENGINE()).toMatch(/if \(isPlayModeRef\.current && !isSimulatingRef\.current\) \{/)
  })

  it('inspects the live scene read-only, except the Transform', () => {
    const hook = read('features', 'nodeInspector', 'useSelectedNode.ts')
    expect(hook).toMatch(/inspectedScene\.getNodeById\(selectedNode\)/)
    expect(hook).toMatch(/const readOnly = isSimulating \|\|/)
    expect(read('features', 'nodeInspector', 'propertyEditors', 'TransformEditor.tsx')).toMatch(/\[props\.node, live\]/)
  })
})
