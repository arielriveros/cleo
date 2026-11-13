import { describe, it, expect, beforeEach } from 'vitest'
import { Scene, UIRootNode, UIPanelNode, UITextNode } from 'cleo'
import { paintUI, layoutLines } from '../src/features/gameUi/uiPaint'

// A movie frame's game UI is painted onto a canvas (gameUi/uiPaint.ts), because the game's UI is DOM and a
// frame read back from the renderer has none of it. The painter must place what the DOM layer places: the
// root's scale, each box's rect, siblings in z order, text lined and aligned as CSS lines it.

type Mat = [number, number, number, number, number, number]
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
]

/** A 2D context that keeps its transform and records what is drawn where (in canvas pixels). */
function recordingContext(width = 1920, height = 1080) {
  const draws: { op: string; x?: number; y?: number; w?: number; h?: number; text?: string; style?: string }[] = []
  let m: Mat = [1, 0, 0, 1, 0, 0]
  const stack: { m: Mat; alpha: number }[] = []
  const apply = (x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] })
  const ctx: any = {
    canvas: { width, height },
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    letterSpacing: '0px',
    save() { stack.push({ m: [...m] as Mat, alpha: this.globalAlpha }) },
    restore() { const s = stack.pop(); if (s) { m = s.m; this.globalAlpha = s.alpha } },
    translate(x: number, y: number) { m = mul(m, [1, 0, 0, 1, x, y]) },
    scale(x: number, y: number) { m = mul(m, [x, 0, 0, y, 0, 0]) },
    rotate(a: number) { const c = Math.cos(a), s = Math.sin(a); m = mul(m, [c, s, -s, c, 0, 0]) },
    getTransform() { return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] } },
    setTransform(a: any, b?: number, c?: number, d?: number, e?: number, f?: number) {
      m = typeof a === 'object' ? [a.a, a.b, a.c, a.d, a.e, a.f] : [a, b!, c!, d!, e!, f!]
    },
    beginPath() {}, clip() {}, arc() {},
    rect(x: number, y: number, w: number, h: number) { const p = apply(x, y); draws.push({ op: 'rect', x: p.x, y: p.y, w: w * m[0], h: h * m[3] }) },
    roundRect(x: number, y: number, w: number, h: number) { this.rect(x, y, w, h) },
    fill() { draws.push({ op: 'fill', style: this.fillStyle }) },
    stroke() { draws.push({ op: 'stroke', style: this.strokeStyle }) },
    fillRect(x: number, y: number, w: number, h: number) { const p = apply(x, y); draws.push({ op: 'fillRect', x: p.x, y: p.y, w, h }) },
    fillText(text: string, x: number, y: number) { const p = apply(x, y); draws.push({ op: 'text', text, x: p.x, y: p.y, style: this.fillStyle }) },
    // Every character 10 px wide, so lines can be checked by hand.
    measureText(text: string) { return { width: text.length * 10, fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 4 } },
    drawImage() { draws.push({ op: 'image' }) },
  }
  return { ctx, draws }
}

describe('layoutLines', () => {
  const w = (s: string) => s.length * 10
  it('wraps at spaces, breaks at newlines and collapses runs of spaces, as pre-line does', () => {
    expect(layoutLines('one two three four', 100, true, w)).toEqual(['one two', 'three four'])
    expect(layoutLines('a\nb   c', 1000, true, w)).toEqual(['a', 'b c'])
  })
  it('keeps everything on one line when not wrapping, as nowrap does', () => {
    expect(layoutLines('one\ntwo  three', 10, false, w)).toEqual(['one two three'])
  })
})

describe('paintUI', () => {
  let scene: Scene
  beforeEach(() => {
    scene = new Scene()
    scene.setUIViewport(1920, 1080, 1)
    scene.start()
  })
  const solve = () => scene.update(1 / 60, 0, false)
  const opts = { defaultFamily: 'sans-serif', defaultFontSize: 16 }

  it('scales a root to the frame and places its boxes and text where the DOM layer would', () => {
    // A 4K frame laid out against a 1080p reference: everything doubles.
    scene.setUIViewport(3840, 2160, 1)
    const root = new UIRootNode('UI')
    root.referenceResolution = [1920, 1080]
    const bar = new UIPanelNode('Bar')
    bar.setAnchor(0, 0)
    bar.setRect(100, 50, 200, 40)
    bar.tint = [0, 0, 0, 1]
    const caption = new UITextNode('Caption')
    caption.setAnchor(0, 0)
    caption.setRect(0, 0, 400, 40)
    caption.text = 'Storm'
    caption.fontSize = 20
    caption.align = 'center'
    root.addChild(bar)
    root.addChild(caption)
    scene.addNode(root)
    solve()

    const { ctx, draws } = recordingContext(3840, 2160)
    paintUI(ctx, scene.uiRoots, opts)
    const box = draws.find(d => d.op === 'rect')!
    expect([box.x, box.y, box.w, box.h]).toEqual([200, 100, 400, 80])
    const text = draws.find(d => d.op === 'text')!
    expect(text.text).toBe('Storm')
    // Centred in 400 reference px: (400 - 50) / 2 = 175, doubled.
    expect(text.x).toBeCloseTo(350, 6)
  })

  it('paints siblings in z order, then tree order, and skips what is hidden', () => {
    const root = new UIRootNode('UI')
    const names = ['Back', 'Front', 'Hidden']
    for (const name of names) {
      const t = new UITextNode(name)
      t.setAnchor(0, 0)
      t.setRect(0, 0, 300, 30)
      t.text = name
      root.addChild(t)
    }
    const [back, front, hidden] = root.uiChildren
    back.zOrder = 2
    front.zOrder = 1
    hidden.visible = false
    scene.addNode(root)
    solve()
    const { ctx, draws } = recordingContext()
    paintUI(ctx, scene.uiRoots, opts)
    expect(draws.filter(d => d.op === 'text').map(d => d.text)).toEqual(['Front', 'Back'])
  })
})
