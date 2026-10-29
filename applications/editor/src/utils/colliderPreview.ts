import { Scene, Node, ModelNode, Model, CameraNode, CleoEngine, markEditorOwned, markEditorOnly, disposeModelSubtree, foliageColliderPose } from 'cleo'
import type { FoliageCollision } from 'cleo'
import { createModelPreviewScene } from '../features/demoScene/createModelPreviewScene'
import { fitDistance, previewClipPlanes } from '../features/demoScene/previewFraming'
import { awaitSubtreeTexturesReady, captureClean, combineBounds, thumbnailSilently as silently } from './modelThumbnails'
import { buildFoliageColliderWire, placeFoliageColliderWire } from './editorHelpers'

/** Red, like a node's collider wireframe: in the preview it is THE thing being edited. */
const PREVIEW_COLLIDER_COLOR: [number, number, number] = [1, 0.25, 0.2]

/**
 * A throwaway scene for the collider editor: the foliage prototype exactly as the engine instances it
 * (`rule.models` at identity, scaled by the instance scale being previewed) with its collider drawn over
 * it, rendered offscreen to an image on demand. Orbit by passing a yaw and pitch per render.
 */
export interface ColliderPreview {
  /** Bounds of the prototype at scale 1: what the camera frames. */
  readonly center: [number, number, number]
  readonly radius: number
  /** Show `collision` (or nothing) at an instance scale of `scale`. */
  setCollider(collision: FoliageCollision | null, scale: number): void
  /** A PNG data URL of the scene from `yawDeg`/`pitchDeg`, `zoom` x the fitted distance. */
  render(size: number, yawDeg: number, pitchDeg: number, zoom: number): Promise<string>
  dispose(): void
}

export async function createColliderPreview(engine: CleoEngine, models: readonly any[]): Promise<ColliderPreview> {
  const built = silently(() => {
    const scene = new Scene()
    const prototype = markEditorOwned(new Node('__collider_prototype'))
    models.forEach((m, i) => prototype.addChild(new ModelNode(`part ${i}`, Model.parse(m))))
    scene.addNode(prototype)
    scene.root.updateTransforms()
    const { center, radius } = combineBounds(prototype)
    createModelPreviewScene(scene, center, radius)
    scene.start()
    return { scene, prototype, center, radius: Math.max(radius, 0.01) }
  })
  await awaitSubtreeTexturesReady(built.prototype)

  const { scene, prototype, center, radius } = built
  let wire: ModelNode | null = null
  let wireShape: string | null = null
  let scale = 1

  return {
    center, radius,
    setCollider(collision, instanceScale) {
      silently(() => {
        scale = instanceScale
        prototype.setUniformScale(scale)
        if (!collision) { if (wire) wire.visible = false; return }
        const pose = foliageColliderPose(collision, scale)
        if (!wire || wireShape !== pose.shape) {
          if (wire) scene.removeNode(wire)
          wire = buildFoliageColliderWire(pose.shape, PREVIEW_COLLIDER_COLOR)
          // Viewport wires are editor-only (drawn in the overlay layer, which an offscreen capture skips);
          // here the wire IS the subject, so it renders with the scene.
          markEditorOnly(wire, false)
          wireShape = pose.shape
          scene.addNode(wire)
        }
        wire.visible = true
        placeFoliageColliderWire(wire, pose, 0, 0, 0, 0)
        scene.root.updateTransforms()
      })
    },
    render(size, yawDeg, pitchDeg, zoom) {
      silently(() => {
        const cam = scene.activeCamera as CameraNode | undefined
        if (!cam) return
        // Orbit the (scaled) prototype's centre. The camera looks along its own +Z, so it faces back
        // toward the centre from the side it sits on: yaw + 180.
        const r = radius * scale
        const dist = fitDistance(r) * zoom
        const yaw = yawDeg * Math.PI / 180, pitch = pitchDeg * Math.PI / 180
        const c: [number, number, number] = [center[0] * scale, center[1] * scale, center[2] * scale]
        cam.setPosition([
          c[0] + Math.sin(yaw) * Math.cos(pitch) * dist,
          c[1] + Math.sin(pitch) * dist,
          c[2] + Math.cos(yaw) * Math.cos(pitch) * dist,
        ])
        cam.setRotation([pitchDeg, yawDeg + 180, 0])
        const planes = previewClipPlanes(dist, r)
        cam.camera.near = planes.near
        cam.camera.far = planes.far
      })
      return captureClean(engine, scene, size)
    },
    dispose() {
      disposeModelSubtree(prototype)
      if (wire) disposeModelSubtree(wire)
    },
  }
}
