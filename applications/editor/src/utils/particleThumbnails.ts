import { Scene, ModelNode, Model, Geometry, Material, ParticleSystemNode, CleoEngine, markEditorOwned } from 'cleo'
import { createModelPreviewScene } from '../features/demoScene/createModelPreviewScene'
import type { ParticleSystemAsset } from './particleSystems'
import { thumbnailSilently } from './modelThumbnails'

// A particle system's card: a moment of the effect, simulated forward and captured against a dark
// backdrop.
//
// THE BACKDROP IS LOAD-BEARING. An offscreen capture takes its alpha from scene DEPTH (see the renderer's
// `_presentThumbnail`), and particles write none — on the usual transparent thumbnail every one of them
// would be cut away. A dark inside-out sphere covers the frame, so the capture is opaque and the
// particles, additive glows included, read against it.

const THUMB_SIZE = 256
/** Seconds of simulation before the shot: long enough for a looping emitter to fill its volume. */
const WARMUP_SECONDS = 2.5
const WARMUP_STEP = 1 / 30

export async function renderParticleSystemThumbnail(engine: CleoEngine, asset: ParticleSystemAsset): Promise<string> {
  // Built silently, like every thumbnail scene: the structural adds must not mark the open tab unsaved.
  const { scene, node } = thumbnailSilently(() => {
    const scene = new Scene()
    scene.particlePreview = true

    const { center, extents } = asset.system.bounds
    const radius = Math.max(0.5, Math.hypot(extents[0], extents[1], extents[2]))

    // Editor-owned, like the backdrop: building a throwaway scene must not mark the open tab unsaved.
    const node = markEditorOwned(new ParticleSystemNode('__thumb_particles', { system: asset.system, playOnStart: true }))
    scene.addNode(node)
    createModelPreviewScene(scene, center, radius)

    // Centred on the CAMERA and reaching just past the effect's far side: everything behind the effect
    // is covered, and no wall lies beyond the preview camera's far plane (a sphere round the effect did,
    // and its far wall clipped into a hole in the middle of the card).
    scene.root.updateTransforms()
    const eye = scene.activeCamera?.worldPosition ?? [0, 0, radius * 3]
    const distance = Math.hypot(eye[0] - center[0], eye[1] - center[1], eye[2] - center[2])
    const backdrop = markEditorOwned(new ModelNode('__thumb_backdrop', new Model(
      Geometry.Sphere(24, distance + radius * 1.2),
      Material.Basic({ color: [0.045, 0.05, 0.065] }, { side: 'double', castShadow: false }))))
    backdrop.setPosition([eye[0], eye[1], eye[2]])
    scene.addNode(backdrop)
    scene.start()
    node.play()
    return { scene, node }
  })

  // Queue the warm-up as ordinary steps; the capture's frame runs them all before it draws.
  scene.root.updateTransforms()
  for (let t = 0; t < WARMUP_SECONDS; t += WARMUP_STEP) node.runtime.advance(WARMUP_STEP, node.worldTransform)

  scene.root.updateTransforms()
  scene.activeCamera?.update(0, 0)
  // The grid goes back on before the readback is awaited — the frame is already drawn (see captureClean).
  const prevGrid = engine.renderer.gridVisible
  engine.renderer.setGridVisible(false)
  let pending: Promise<string>
  try {
    pending = engine.renderer.screenshotOffscreen(scene, THUMB_SIZE)
  } finally {
    engine.renderer.setGridVisible(prevGrid)
  }
  return pending
}
