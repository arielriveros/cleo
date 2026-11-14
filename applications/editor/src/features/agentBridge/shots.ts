import type { Node } from 'cleo'
import { paneView } from '../viewportPanes/paneView'
import { loadPaneState } from '../viewportPanes/paneState'
import { ready, refIn, throwIfAborted, type CommandResult, type GetHost } from './bridgeHost'
import { composite, encode, frameNode, grabFrame, type CropRect } from './capture'
import { nodePath } from './nodeRefs'

// The agent's screenshots: one view, or up to four angles around a node composited into one image (about
// the cost of a single large shot), of the viewport's EDITING pane when it is split.

/** What the `capture` option of a tool and view_capture take. */
export interface CaptureSpec {
  focus?: string
  yaw?: number
  pitch?: number
  views?: 'quad' | { yaw: number; pitch?: number }[]
  pane?: 'editing' | 'all'
  maxSize?: number
  format?: 'jpeg' | 'png'
}

/** The viewport's split as a phrase, and the editing pane's preset ("top", "perspective"...). */
export function describePanes(): { split: boolean; text: string; preset: string } {
  const view = paneView()
  if (!view.active) return { split: false, text: 'single view', preset: 'perspective' }
  let preset = 'perspective'
  try { preset = loadPaneState().panes[view.focused]?.preset ?? preset } catch { /* storage unavailable */ }
  return { split: true, text: `split ${view.layout} (${view.boxes.length} panes), editing pane ${view.focused + 1}: ${preset}`, preset }
}

/** The four sides of a node at the call's pitch, starting from its yaw. */
function angles(spec: CaptureSpec): { yaw: number; pitch: number }[] {
  const yaw = spec.yaw ?? 35, pitch = spec.pitch ?? 25
  if (!spec.views) return [{ yaw, pitch }]
  if (spec.views === 'quad') return [0, 90, 180, 270].map(d => ({ yaw: yaw + d, pitch }))
  return spec.views.slice(0, 4).map(v => ({ yaw: v.yaw, pitch: v.pitch ?? pitch }))
}

/**
 * A viewport capture. `settle` frames are rendered first when nothing else asks for more: after an edit,
 * temporal AA would otherwise blend a new object in half-faded. Framing a node waits longer (12 frames),
 * since the whole view jumped; a split viewport waits a little more, so its previews (which take turns
 * redrawing) catch up.
 */
export async function takeCapture(getHost: GetHost, spec: CaptureSpec, opts: { aliases?: ReadonlyMap<string, Node>; defaultMax: number; settle?: number; signal?: AbortSignal }): Promise<{ text: string; image: { data: string; mimeType: string } }> {
  const h = ready(getHost)
  const engine = h.engine.instance!
  const renderer = engine.renderer
  const panes = describePanes()
  const crop: CropRect | null = spec.pane === 'all' ? null : renderer.editingPaneRect
  const maxSize = spec.maxSize ?? opts.defaultMax
  const settle = (opts.settle ?? 0) + (panes.split && spec.pane === 'all' ? 3 : 0)
  const format = spec.format ?? 'jpeg'
  let note = ''

  if (spec.views && !spec.focus) throw new Error('views need focus: the node to look at from those angles.')
  if (!spec.focus) {
    const frame = await grabFrame(renderer, { maxSize, skipFrames: settle, crop })
    const shot = encode(frame, format)
    return { text: `Capture of ${what(getHost)}, ${shot.width}x${shot.height}${panes.split ? ` (${panes.text}${crop ? '' : ', every pane'})` : ''}.`, image: shot }
  }

  // The editor camera is in use while editing and in Simulate; Play looks through the game's camera.
  if (h.engine.isPlayMode && !h.engine.isSimulating)
    throw new Error('focus moves the editor camera, which Play does not look through. Capture without focus, or use simulate.')
  const scene = h.engine.isPlayMode ? engine.scene : h.engine.editorScene
  const node = refIn(h, scene, spec.focus, opts.aliases)
  const camera = engine.scene.activeCamera
  if (!camera || !camera.isEditorOwned) throw new Error('The editor camera is not available in this tab.')
  const ortho = camera.camera.type === 'orthographic'
  const list = angles(spec)
  if (ortho && list.length > 1)
    throw new Error(`The editing view is orthographic (${panes.preset}), which looks along one axis: views need a perspective pane.`)
  // World matrices and bounds catch up with setPosition only in the next frame's update: a node created or
  // moved in this same call would be framed where it was. Bring them up to date first.
  scene.root.updateTransforms(null)

  const before = { position: Array.from(camera.position), rotation: Array.from(camera.rotation) }
  const frames: HTMLCanvasElement[] = []
  // Each view of a sheet is half the size, so the sheet costs what one shot does.
  const cell = list.length > 1 ? Math.round(maxSize / 2) : maxSize
  try {
    for (const a of list) {
      throwIfAborted(opts.signal)
      frameNode(camera, node, a.yaw, a.pitch)
      frames.push(await grabFrame(renderer, { maxSize: cell, skipFrames: 12 + settle, crop }))
    }
  } finally {
    // A sheet puts the camera back where the user had it; a single framing leaves it there, as View ▸ Frame does.
    if (list.length > 1) { camera.setPosition(before.position as any); camera.setRotation(before.rotation as any) }
  }
  const shot = encode(frames.length > 1 ? composite(frames) : frames[0], format)
  const path = nodePath(node, scene.root)
  const angle = (x: { yaw: number; pitch: number }) => `yaw ${Math.round(x.yaw)} pitch ${Math.round(x.pitch)}`
  if (list.length > 1) note = ` ${list.length} views of ${path}, left to right, top to bottom: ${list.map(angle).join('; ')} (the editor camera was put back).`
  else if (ortho) note = ` Framed ${path} (the orthographic ${panes.preset} view kept its direction and zoomed to fit${spec.yaw !== undefined || spec.pitch !== undefined ? '; yaw and pitch apply only to a perspective view' : ''}).`
  else note = ` Framed ${path} (the editor camera moved).`
  return { text: `Capture of ${what(getHost)}, ${shot.width}x${shot.height}${panes.split ? ` (${panes.text})` : ''}.${note}`, image: shot }
}

function what(getHost: GetHost): string {
  const e = getHost().engine
  return e.isPlayMode ? (e.isSimulating ? 'the simulation' : 'the running game') : `the ${e.activeTab?.title ?? 'scene'} viewport`
}

/** Attach a capture to a result when the call asked for one. A failed capture is a note, never a failed call. */
export async function withCapture(result: CommandResult, capture: unknown, getHost: GetHost, aliases?: ReadonlyMap<string, Node>, signal?: AbortSignal): Promise<CommandResult> {
  if (!capture) return result
  const spec: CaptureSpec = capture === true ? {} : (capture as CaptureSpec)
  try {
    const shot = await takeCapture(getHost, spec, { aliases, defaultMax: 768, settle: 4, signal })
    return { ...result, text: `${result.text ?? ''}\n${shot.text}`, images: [...(result.images ?? []), shot.image] }
  } catch (err) {
    return { ...result, text: `${result.text ?? ''}\n(No capture: ${err instanceof Error ? err.message : String(err)})` }
  }
}
