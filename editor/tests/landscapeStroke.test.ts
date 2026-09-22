import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// The landscape brush's stroke contract. These are source assertions for the same reason
// editorChromeNodes' are: the brush is pointer handlers over a live Terrain, and the rules that keep
// breaking are ordering rules — what happens on release, in what order, and against which node.

const BRUSH = readFileSync(join(__dirname, '..', 'src', 'features', 'landscape', 'LandscapeBrush.tsx'), 'utf8')

describe('a landscape stroke', () => {
  it('pushes exactly one undo entry, and that entry finds the landscape by id when it runs', () => {
    // Not by captured reference: an unrelated snapshot undo re-parses the node, and a captured Terrain
    // would then write into a disposed one — the same trap that made heightmap import silently do nothing.
    expect(BRUSH).toMatch(/pushRef\.current\(\{ label: s\.label, undo: \(\) => put\('before'\), redo: \(\) => put\('after'\) \}\)/)
    expect(BRUSH).toMatch(/const put = \(side: 'before' \| 'after'\) => \{[\s\S]{0,300}scene\.getNodeById\(s\.nodeId\)/)
  })

  it('records only the rectangle it touched, from a snapshot taken at stroke start', () => {
    expect(BRUSH).toMatch(/heightsBefore: b\.mode === 'sculpt' \? terrain\.heights\.slice\(\) : null/)
    expect(BRUSH).toMatch(/masksBefore: b\.mode === 'paint' \? terrain\.layerStack\.masks\.clone\(\) : null/)
    expect(BRUSH).toMatch(/unionRegion\(s\.heightRegion, region\)/)
    expect(BRUSH).toMatch(/unionRegion\(s\.maskRegion, region\)/)
  })

  it('refreshes the history baseline for that node, on the stroke and on undo/redo', () => {
    // A stale baseline makes the NEXT rename or move record a diff whose undo also reverts the sculpting.
    const emits = BRUSH.match(/emit\('TERRAIN_EDITED'/g) ?? []
    expect(emits.length).toBeGreaterThanOrEqual(2)
    expect(BRUSH).toMatch(/if \(strokeNodeId\) eventEmitter\.emit\('TERRAIN_EDITED', strokeNodeId\)/)
  })

  it('keeps applying while the mouse is held still, and only then', () => {
    expect(BRUSH).toMatch(/if \(getBrush\(\)\.continuous \|\| p\.moved\) apply\(/)
    expect(BRUSH).toMatch(/rafRef\.current = requestAnimationFrame\(tick\)/)
  })

  it('lays a ramp on release and lets Escape cancel it', () => {
    expect(BRUSH).toMatch(/if \(rampStartRef\.current\) layRamp\(\)/)
    expect(BRUSH).toMatch(/if \(e\.key === 'Escape' && rampStartRef\.current\)/)
  })

  it('picks a height with Ctrl+click instead of starting a stroke', () => {
    expect(BRUSH).toMatch(/b\.mode === 'sculpt' && e\.ctrlKey && \(b\.sculptTool === 'flatten' \|\| b\.sculptTool === 'setHeight'\)/)
    expect(BRUSH).toMatch(/setBrush\(\{ setHeight: y,/)
  })

  it('takes Ctrl+wheel for the brush size before the camera can zoom with it', () => {
    // Capture phase on the viewport AND stopPropagation: the camera listens on the canvas below.
    expect(BRUSH).toMatch(/addEventListener\('wheel', onWheel, \{ capture: true, passive: false \}\)/)
    expect(BRUSH).toMatch(/const onWheel = \(e: WheelEvent\) => \{[\s\S]{0,200}e\.preventDefault\(\);\s*e\.stopPropagation\(\)/)
  })

  it('erases foliage before it scatters, so a stroke does not remove what it just placed', () => {
    const erase = BRUSH.indexOf('eraseFoliageExcept(')
    const scatter = BRUSH.indexOf('scatterFoliageFromMaterials(point')
    expect(erase).toBeGreaterThan(0)
    expect(scatter).toBeGreaterThan(erase)
  })
})
