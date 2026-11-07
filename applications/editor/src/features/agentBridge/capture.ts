import type { CameraNode, Node, Renderer } from 'cleo'
import { userChildren } from './nodeRefs'

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

/** World-space box around a node and its visible descendants, or null if nothing in it has extent. */
export function subtreeBounds(node: Node): { center: number[]; radius: number } | null {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  const grow = (n: Node) => {
    try {
      const b = n.getBoundingBox()
      if (b && Number.isFinite(b.min[0]) && Number.isFinite(b.max[0])) {
        for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.min[i]); max[i] = Math.max(max[i], b.max[i]) }
      }
    } catch { /* a node type without bounds */ }
    for (const c of userChildren(n)) grow(c)
  }
  grow(node)
  if (!Number.isFinite(min[0])) return null
  const center = [0, 1, 2].map(i => (min[i] + max[i]) / 2)
  const radius = Math.max(0.25, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2)
  return { center, radius }
}

/**
 * Put the editor camera on an orbit around `node`: `yaw` degrees around it (0 = looking along +Z), `pitch`
 * degrees above the horizon, far enough back to fit its bounds. A camera at yaw θ looks along
 * [sin θ, 0, cos θ] (a node faces +Z), and a positive pitch looks down.
 */
export function frameNode(camera: CameraNode, node: Node, yaw = 35, pitch = 25): void {
  const b = subtreeBounds(node)
  const wp = node.worldPosition
  const center = b?.center ?? [wp[0], wp[1], wp[2]]
  const radius = b?.radius ?? 1
  const fovY = ((camera.camera as any)?.fov ?? 60) * Math.PI / 180
  const distance = (radius / Math.sin(Math.max(0.2, fovY / 2))) * 1.15
  const yr = yaw * Math.PI / 180, pr = pitch * Math.PI / 180
  // Unit vector from the target back to the camera.
  const back = [-Math.sin(yr) * Math.cos(pr), Math.sin(pr), -Math.cos(yr) * Math.cos(pr)]
  const pos = [0, 1, 2].map(i => center[i] + back[i] * distance)
  const look = [0, 1, 2].map(i => center[i] - pos[i])
  const len = Math.hypot(look[0], look[1], look[2]) || 1
  const camYaw = Math.atan2(look[0], look[2]) * 180 / Math.PI
  const camPitch = Math.asin(-look[1] / len) * 180 / Math.PI
  camera.setPosition([pos[0], pos[1], pos[2]] as any)
  camera.setRotation([camPitch, camYaw, 0] as any)
}
