import type { Renderer } from 'cleo'

// The viewport as the user sees it, for the agent to look at.
//
// Read in the SAME task the renderer presents in: a WebGPU canvas's current texture is only valid until
// that task ends, so a toDataURL from any other callback comes back black (the docsMedia prelude's
// canvasDataUrl does the same). So the next `render` call is wrapped once, and the canvas is scaled and
// encoded right after it returns.

export interface Capture { data: string; mimeType: string; width: number; height: number }

const FRAME_TIMEOUT_MS = 5000

export function captureViewport(renderer: Renderer, opts: { maxSize: number; format: 'jpeg' | 'png'; skipFrames?: number }): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const r = renderer as any
    const hadOwn = Object.prototype.hasOwnProperty.call(r, 'render')
    const previous = r.render
    const restore = () => { if (hadOwn) r.render = previous; else delete r.render }
    let skip = opts.skipFrames ?? 0
    const timer = window.setTimeout(() => {
      restore()
      reject(new Error('No frame was rendered within 5 s. Browsers pause rendering in hidden or minimised tabs: '
        + 'bring the editor to the front (or un-hide its viewport panel) and try again.'))
    }, FRAME_TIMEOUT_MS + skip * 250)
    r.render = function (this: unknown, ...args: unknown[]) {
      const out = previous.apply(this, args)
      if (skip-- > 0) return out
      restore()
      window.clearTimeout(timer)
      try { resolve(encode(renderer.canvas, opts)) } catch (err) { reject(err) }
      return out
    }
  })
}

function encode(source: HTMLCanvasElement, { maxSize, format }: { maxSize: number; format: 'jpeg' | 'png' }): Capture {
  const w = source.width, h = source.height
  if (!w || !h) throw new Error('The viewport has no size (its panel is collapsed or hidden).')
  const scale = Math.min(1, maxSize / Math.max(w, h))
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(w * scale))
  out.height = Math.max(1, Math.round(h * scale))
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('Could not create a 2D canvas to encode the capture.')
  ctx.drawImage(source, 0, 0, out.width, out.height)
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'
  const url = out.toDataURL(mimeType, 0.88)
  return { data: url.slice(url.indexOf(',') + 1), mimeType, width: out.width, height: out.height }
}

// Framing a node moved to features/viewport/frameNode.ts (View ▸ Frame Selected uses it too); kept
// importable from here for the agent's commands.
export { frameNode, frameOrtho, subtreeBounds, type SubtreeBounds } from '../viewport/frameNode'
