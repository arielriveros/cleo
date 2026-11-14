import type { Renderer } from 'cleo'

// The viewport as the user sees it, for the agent to look at.
//
// Read in the SAME task the renderer presents in: a WebGPU canvas's current texture is only valid until
// that task ends, so a toDataURL from any other callback comes back black (the docsMedia prelude's
// canvasDataUrl does the same). So the next `render` call is wrapped once, and the canvas is copied right
// after it returns. Encoding (and compositing several views) happens on that copy, afterwards.

export interface Capture { data: string; mimeType: string; width: number; height: number }

/** A region of the canvas in canvas pixels from its top left: what a split viewport's pane occupies. */
export interface CropRect { x: number; y: number; w: number; h: number }

const FRAME_TIMEOUT_MS = 5000

/**
 * The part of a `width` x `height` canvas to keep: `rect` clamped inside it, or the whole canvas when there
 * is no rect (no split) or nothing of it is left. Integer pixels, at least one each way.
 */
export function cropRegion(width: number, height: number, rect: CropRect | null | undefined): CropRect {
  if (!rect) return { x: 0, y: 0, w: width, h: height }
  const x = Math.max(0, Math.min(width, Math.round(rect.x)))
  const y = Math.max(0, Math.min(height, Math.round(rect.y)))
  const w = Math.min(width - x, Math.round(rect.w))
  const h = Math.min(height - y, Math.round(rect.h))
  return w >= 1 && h >= 1 ? { x, y, w, h } : { x: 0, y: 0, w: width, h: height }
}

/** The size a `w` x `h` image is scaled to so its longest side is at most `maxSize` (never enlarged). */
export function fitSize(w: number, h: number, maxSize: number): { width: number; height: number } {
  const scale = Math.min(1, maxSize / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

/**
 * Copy the canvas (or the `crop` part of it) right after the next rendered frame, `skipFrames` frames
 * later, scaled to fit `maxSize`. Resolves with a 2D canvas holding the copy.
 */
export function grabFrame(renderer: Renderer, opts: { maxSize: number; skipFrames?: number; crop?: CropRect | null }): Promise<HTMLCanvasElement> {
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
      try { resolve(copy(renderer.canvas, opts.maxSize, opts.crop)) } catch (err) { reject(err) }
      return out
    }
  })
}

function copy(source: HTMLCanvasElement, maxSize: number, crop: CropRect | null | undefined): HTMLCanvasElement {
  if (!source.width || !source.height) throw new Error('The viewport has no size (its panel is collapsed or hidden).')
  const region = cropRegion(source.width, source.height, crop)
  const size = fitSize(region.w, region.h, maxSize)
  const out = document.createElement('canvas')
  out.width = size.width
  out.height = size.height
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('Could not create a 2D canvas to encode the capture.')
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, out.width, out.height)
  return out
}

/** Several frames side by side, two to a row (a 2x2 sheet for four), each cell the size of the first. */
export function composite(frames: HTMLCanvasElement[]): HTMLCanvasElement {
  const cols = frames.length === 1 ? 1 : 2
  const rows = Math.ceil(frames.length / cols)
  const cw = frames[0].width, ch = frames[0].height
  const out = document.createElement('canvas')
  out.width = cw * cols
  out.height = ch * rows
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('Could not create a 2D canvas to compose the views.')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, out.width, out.height)
  frames.forEach((f, i) => ctx.drawImage(f, (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch))
  return out
}

export function encode(canvas: HTMLCanvasElement, format: 'jpeg' | 'png'): Capture {
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'
  const url = canvas.toDataURL(mimeType, 0.88)
  return { data: url.slice(url.indexOf(',') + 1), mimeType, width: canvas.width, height: canvas.height }
}

/** One frame, encoded: the whole canvas or the `crop` part. */
export async function captureViewport(renderer: Renderer, opts: { maxSize: number; format: 'jpeg' | 'png'; skipFrames?: number; crop?: CropRect | null }): Promise<Capture> {
  return encode(await grabFrame(renderer, opts), opts.format)
}

// Framing a node moved to features/viewport/frameNode.ts (View ▸ Frame Selected uses it too); kept
// importable from here for the agent's commands.
export { frameNode, frameOrtho, subtreeBounds, type SubtreeBounds } from '../viewport/frameNode'
