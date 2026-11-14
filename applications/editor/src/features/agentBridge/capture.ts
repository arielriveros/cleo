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

export interface SubtreeBounds { min: number[]; max: number[]; center: number[]; size: number[]; radius: number }

/** World-space box around a node and its visible descendants, or null if nothing in it has extent. */
export function subtreeBounds(node: Node): SubtreeBounds | null {
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
  const size = [0, 1, 2].map(i => max[i] - min[i])
  const radius = Math.max(0.25, Math.hypot(size[0], size[1], size[2]) / 2)
  return { min, max, center, size, radius }
}

/** How much room a framing leaves around what it frames: the bounds take 1/1.15 of the view. */
const FRAME_MARGIN = 1.15

/**
 * Put the editor camera on an orbit around `node`: `yaw` degrees around it (0 = looking along +Z), `pitch`
 * degrees above the horizon, far enough back to fit its bounds. A camera at yaw θ looks along
 * [sin θ, 0, cos θ] (a node faces +Z), and a positive pitch looks down. An orthographic camera is framed by
 * `frameOrtho` instead, and `yaw`/`pitch` do not apply.
 */
export function frameNode(camera: CameraNode, node: Node, yaw = 35, pitch = 25): void {
  const b = subtreeBounds(node)
  const wp = node.worldPosition
  const center = b?.center ?? [wp[0], wp[1], wp[2]]
  if (camera.camera.type === 'orthographic') {
    frameOrtho(camera, center, b ? b.size.map(s => s / 2) : [1, 1, 1])
    return
  }
  const radius = b?.radius ?? 1
  const fovY = ((camera.camera as any)?.fov ?? 60) * Math.PI / 180
  const distance = (radius / Math.sin(Math.max(0.2, fovY / 2))) * FRAME_MARGIN
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

/** The smallest half-height a framing zooms an orthographic view to, in metres. */
const MIN_ORTHO_HALF = 0.25

/**
 * Frame a world-space box (`center`, `half` its half-size per axis) in an orthographic camera without
 * turning it, so a split viewport's Top or Front pane, or the 2D view, still looks along its axis. The
 * camera slides across its view until the box is centred, and its extents zoom until the box fits, with
 * the margin an orbit framing leaves.
 *
 * Along the view: a camera that measures detail at a set depth (`Camera.detailDistance`, a pane camera's
 * standoff) stands that far back from the centre, so LOD and foliage are measured at the node itself; any
 * other camera keeps the depth it had (the 2D view stays at its own). Either way it backs off until the
 * whole box lies past its near plane.
 */
export function frameOrtho(camera: CameraNode, center: ArrayLike<number>, half: ArrayLike<number>): void {
  const cam = camera.camera
  const f = camera.worldForward
  const up = cam.up
  // The screen axes, as the view matrix builds them (a look-at along `f` with `up`).
  let right = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]]
  let len = Math.hypot(right[0], right[1], right[2])
  // An up along the view (never one of the pane presets): any axis across it frames the same box.
  if (len < 1e-6) {
    right = Math.abs(f[0]) < 0.9 ? [0, f[2], -f[1]] : [-f[2], 0, f[0]]
    len = Math.hypot(right[0], right[1], right[2])
  }
  right = right.map(v => v / len)
  const screenUp = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]]
  // A box's half-extent along a unit axis.
  const along = (a: ArrayLike<number>) => Math.abs(a[0]) * half[0] + Math.abs(a[1]) * half[1] + Math.abs(a[2]) * half[2]
  // The projection widens left/right by the view's aspect, so the box's width counts against it.
  const ratio = cam.ratio > 0 ? cam.ratio : 1
  const h = Math.max(MIN_ORTHO_HALF, Math.max(along(screenUp), along(right) / ratio) * FRAME_MARGIN)
  const p = camera.worldPosition
  const depthNow = (center[0] - p[0]) * f[0] + (center[1] - p[1]) * f[1] + (center[2] - p[2]) * f[2]
  const depth = Math.max(cam.detailDistance > 0 ? cam.detailDistance : depthNow, along(f) + cam.near * 2)
  const pos: [number, number, number] = [center[0] - f[0] * depth, center[1] - f[1] * depth, center[2] - f[2] * depth]
  camera.setPosition(pos)
  cam.top = h
  cam.bottom = -h
  cam.left = -h
  cam.right = h
}
