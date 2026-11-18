import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// The Performance page samples and profiles only while it is on screen. A dock tab behind another stays mounted
// (dockview detaches its DOM, not its React tree), so the page used to keep its per-frame loop, the physics step
// split, and any Timer queries or script/animator split it had switched on, running behind the Editor or Project
// tab, and after the page was left. Source-text checks, for the reason performancePlayPin.test.ts gives.

const read = (...p: string[]) => readFileSync(join(__dirname, '..', '..', ...p), 'utf-8').replace(/\r\n/g, '\n')
const panel = () => read('app-kit', 'src', 'renderer', 'PerformancePanel.tsx')

describe('the Performance page only measures while shown', () => {
  it('learns whether it is on screen from its dock tab', () => {
    const panels = read('editor', 'src', 'features', 'layout', 'panels.tsx')
    expect(panels).toMatch(/function EngineOptionsDockPanel\(props: IDockviewPanelProps\) \{\s+const active = useIsSelectedTab\(props\.api\);\s+return <OptionsDockFrame><EngineOptionsPanel active=\{active\} \/><\/OptionsDockFrame>;/)
    const engine = read('editor', 'src', 'features', 'options', 'EngineOptionsPanel.tsx')
    expect(engine).toContain('export default function EngineOptionsPanel({ active = true }: { active?: boolean } = {})')
    expect(engine).toContain('<PerformancePanel active={active}')
    // Other hosts (the Creator) pass nothing and keep sampling as before.
    expect(panel()).toContain('playPin, active = true }')
  })

  it('stops the sampling loop and the physics step split while hidden', () => {
    const src = panel()
    expect(src).toMatch(/if \(!physics \|\| !active\) return;\s+physics\.profileStep = true;/)
    expect(src).toContain('}, [instance, active]);')
    expect(src).toMatch(/useEffect\(\(\) => \{\s+\/\/ Nothing is sampled behind another tab[\s\S]{0,200}if \(!active\) return;\s+let raf = 0;/)
    expect(src).toContain('}, [renderer, instance, active]);')
  })

  it('runs the Timer queries and the script/animator split only while shown and wanted', () => {
    const src = panel()
    expect(src).toMatch(/if \(!active \|\| !enabled\) return;\s+gpuProfiler\.enabled = true;\s+return \(\) => \{ gpuProfiler\.enabled = false; \};/)
    expect(src).toMatch(/if \(!active \|\| !detail\) return;\s+sceneStatsDetail\.enabled = true;\s+return \(\) => \{ sceneStatsDetail\.enabled = false; \};/)
    // The switches record what the user wants, for the session; only the effects above touch the profilers.
    expect(src).toContain("onChange={v => { wanted.timer = v; setEnabled(v); }}")
    expect(src).toContain("onClick={() => { wanted.detail = !detail; setDetail(!detail); }}")
    expect(src).not.toMatch(/onChange=\{v => \{ gpuProfiler\.enabled = v/)
  })
})
