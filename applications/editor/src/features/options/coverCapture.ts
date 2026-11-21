import { CameraNode, TextureManager, captureStill, type CleoEngine, type Scene } from 'cleo'
import { loadPaneState, paneCount } from '../viewportPanes/paneState'
import { findCamera, mainCamera, paneCameraName } from '../viewportPanes/paneCameras'
import { applyAdd, applyDelete, joinPath, KIND_EXT, SOURCE_FOLDER, uniquePath, type VfsIndex } from '../../utils/vfs'
import { deleteTextures } from '../../utils/textureStore'
import { textureSourceBlob } from '../publish/gameIcons'
import type { TextureAsset } from '../../utils/textureAssets'

// Options ▸ Project ▸ Published game ▸ Cover: the project's picture, captured from the editing view.
//
// The capture is the engine's `captureStill`: the movie path, which draws into a target of its own and composites
// nothing of the editor (grid, gizmos, collider wireframes, icons, the selection outline), at the movie's full
// detail. It looks through the camera of the pane being edited — the split viewport's focused pane, else the main
// editor camera — even from Options, where the viewport is one view again: what you framed in the scene is what
// you get.
//
// It becomes an ordinary image asset, `/Publishing/Cover` (its image under `Publishing/Source`), so it travels with
// the project like any other: in a folder project it is a file in Assets/. A new capture replaces the last one it
// made; a cover picked from the project's images is never deleted.

/** The cover's size: 16:9, at a size a launcher or a store page shows sharp. */
export const COVER_WIDTH = 1920
export const COVER_HEIGHT = 1080
/** JPEG, not PNG: a photographic frame is a sixth the size, and a re-capture is another file in git. */
export const COVER_MIME = 'image/jpeg'
export const COVER_QUALITY = 0.92
/** Where captures go in the Assets explorer. */
export const COVER_FOLDER = '/Publishing'
/** The texture ids captures are given (and the only ones a new capture deletes). */
const CAPTURE_ID = /^cover-[0-9a-f]{8}\.jpg$/
/** The project card's copy of the cover (the project browser's thumbnail), wide side in pixels. */
export const CARD_WIDTH = 640

export const isCapturedCover = (id: string): boolean => CAPTURE_ID.test(id)

/**
 * The camera of the pane being edited: in a split 3D viewport the focused pane's (its camera exists only while the
 * split does), else the editor's main camera — pane 0, and the one a single view, 2D and Simulate use.
 */
export function primaryPaneCamera(scene: Scene): CameraNode | null {
  const state = loadPaneState()
  if (state.layout !== 'single' && state.focused > 0) {
    const pane = Math.min(state.focused, paneCount(state.layout) - 1)
    const camera = pane > 0 ? findCamera(scene, paneCameraName(pane)) : null
    if (camera) return camera
  }
  return mainCamera(scene) ?? scene.activeCamera ?? null
}

/** Why a capture cannot run now, or null when it can. */
export function coverCaptureBlocked(opts: { engine: CleoEngine | null; scene: Scene | null; isPlayMode: boolean }): string | null {
  const { engine, scene, isPlayMode } = opts
  if (!engine || !scene) return 'The scene is still loading'
  if (isPlayMode) return 'Stop the game first'
  if (engine.scene !== scene) return 'Switch to the scene tab: the open tab shows something else'
  if (engine.renderer.movieActive) return 'A movie is rendering'
  if (!primaryPaneCamera(scene)) return 'The scene has no editor camera'
  return null
}

/** RGBA (top row first) as compressed image bytes. */
async function encodeRgba(rgba: Uint8Array, width: number, height: number, mime = COVER_MIME, quality = COVER_QUALITY): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2D canvas to encode the capture with')
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0)
  const blob = await canvas.convertToBlob({ type: mime, quality })
  return new Uint8Array(await blob.arrayBuffer())
}

/** A fresh capture id: `cover-1a2b3c4d.jpg` (a texture id is a filename; this one says what made it). */
function newCaptureId(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return `cover-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}.jpg`
}

export interface CoverCaptureDeps {
  engine: CleoEngine
  scene: Scene
  setVfs: (fn: (prev: VfsIndex) => VfsIndex) => void
  emit: (event: string) => void
  onProgress?: (detail: string) => void
  signal?: AbortSignal
}

/**
 * Capture the editing view as a new cover image and register it (its texture, its image and their explorer
 * entries). Resolves with the new texture id; the caller points `identity.cover` at it.
 */
export async function captureCover(deps: CoverCaptureDeps): Promise<string> {
  const { engine, scene } = deps
  const camera = primaryPaneCamera(scene)
  if (!camera) throw new Error('The scene has no editor camera')
  const rgba = await captureStill(engine, {
    width: COVER_WIDTH, height: COVER_HEIGHT, camera, samples: 16, signal: deps.signal,
    onProgress: p => deps.onProgress?.(p.phase === 'warmup' ? 'Converging lighting' : `Sampling ${p.sample}/${p.samples}`),
  })
  deps.onProgress?.('Encoding')
  const bytes = await encodeRgba(rgba, COVER_WIDTH, COVER_HEIGHT)
  const id = newCaptureId()
  // Bytes retained, so the texture store and a folder project's Assets/ keep it; the reconciler (VfsContext)
  // then mints its image and texture records, named after the entries placed here first.
  TextureManager.Instance.addTextureFromBytes(bytes, COVER_MIME, { wrapping: 'clamp' }, id)
  deps.setVfs(prev => {
    const taken = new Set<string>([...prev.entries.map(e => e.path), ...prev.folders])
    const texturePath = uniquePath(taken, COVER_FOLDER, 'Cover', KIND_EXT.texture)
    const stem = texturePath.slice(COVER_FOLDER.length + 1, -KIND_EXT.texture.length)
    const imagePath = uniquePath(taken, joinPath(COVER_FOLDER, SOURCE_FOLDER), stem, '.jpg')
    const now = Date.now()
    return applyAdd(applyAdd(prev, { path: texturePath, kind: 'texture', assetId: id, created: now, size: bytes.byteLength }),
      { path: imagePath, kind: 'image', assetId: id, created: now, size: bytes.byteLength })
  })
  deps.emit('TEXTURES_CHANGED')
  return id
}

export interface CoverRemovalDeps {
  textures: TextureAsset[]
  setVfs: (fn: (prev: VfsIndex) => VfsIndex) => void
  removeTextureAsset: (id: string) => void
  removeImage: (id: string) => void
  emit: (event: string) => void
  /** Whether anything else in the project uses the texture (a material, a scene): then it stays. */
  isUsedElsewhere: (id: string) => boolean
}

/**
 * Delete a cover a capture made, once a new one replaces it: its texture, its image, their bytes and their
 * explorer entries. Anything else (an image the user picked, a capture something else has started using) stays.
 */
export function removeCapturedCover(id: string, deps: CoverRemovalDeps): boolean {
  if (!isCapturedCover(id) || deps.isUsedElsewhere(id)) return false
  const asset = deps.textures.find(t => t.id === id)
  const imageId = asset?.source.kind === 'image' ? asset.source.imageId : id
  TextureManager.Instance.removeTexture(id)
  deps.removeTextureAsset(id)
  deps.removeImage(imageId)
  void deleteTextures([imageId])
  deps.setVfs(prev => applyDelete(prev, prev.entries.filter(e => e.assetId === id || e.assetId === imageId).map(e => e.path)))
  deps.emit('TEXTURES_CHANGED')
  return true
}

/**
 * The project card's picture (the project browser's thumbnail) of a cover: a JPEG data URL `CARD_WIDTH` wide.
 * Null when the texture's bytes cannot be found.
 */
export async function coverCardImage(textureId: string, textures: readonly TextureAsset[]): Promise<string | null> {
  const blob = await textureSourceBlob(textureId, textures)
  if (!blob) return null
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, CARD_WIDTH / bitmap.width)
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, w, h)
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(out)
    })
  } finally {
    bitmap.close()
  }
}
