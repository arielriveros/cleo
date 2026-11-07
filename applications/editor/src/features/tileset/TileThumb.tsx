import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@cleo/app-kit/ui'
import type { TilesetAsset } from '../../utils/tilesets'
import { tileRect } from '../../utils/tilesets'
import { awaitTextureImage, textureImage } from '../../utils/textureReady'
import { useEventBus } from '../EventBusContext'

// Pictures of single tiles, cut out of the atlas: a thumbnail wherever the editor lists tiles (animation
// frames, variant and auto-tile sets) and a live preview of the tile being edited.

/**
 * The decoded atlas image for a texture id. Resolved in an effect, not a memo: TextureManager decodes
 * asynchronously, so a just-registered texture has no image yet and a memo would never see the decode land.
 * It also re-resolves on `TEXTURES_CHANGED`: on a reload the tileset tab is restored BEFORE the texture store
 * has registered the atlas, and an id that is not registered yet has nothing to wait for.
 */
export function useAtlasImage(textureId: string): HTMLImageElement | null {
  const eventEmitter = useEventBus()
  const [image, setImage] = useState<HTMLImageElement | null>(() => (textureId ? textureImage(textureId) : null))
  useEffect(() => {
    let cancelled = false
    const resolve = () => {
      setImage(textureId ? textureImage(textureId) : null)
      if (textureId) void awaitTextureImage(textureId).then(img => { if (!cancelled && img) setImage(img) })
    }
    resolve()
    eventEmitter.on('TEXTURES_CHANGED', resolve)
    return () => { cancelled = true; eventEmitter.off('TEXTURES_CHANGED', resolve) }
  }, [textureId, eventEmitter])
  return image
}

/** The atlas image's URL, or '' while there is none. */
export function useAtlasSrc(textureId: string): string {
  return useAtlasImage(textureId)?.src ?? ''
}

export interface TileThumbProps {
  asset: TilesetAsset
  index: number
  /** The box the tile is fitted into, in CSS pixels. */
  size?: number
  /** The atlas URL, when the caller already has it (saves each thumbnail resolving it again). */
  src?: string
  className?: string
  title?: string
}

/** One tile at thumbnail size: a CSS crop of the atlas, nearest-neighbour so pixel art stays crisp. */
export function TileThumb({ asset, index, size = 24, src: srcProp, className, title }: TileThumbProps) {
  const own = useAtlasSrc(srcProp === undefined ? asset.textureId : '')
  const src = srcProp ?? own
  const r = tileRect(asset, index)
  const scale = size / Math.max(1, r.w, r.h)
  return (
    <span
      className={cn('inline-flex items-center justify-center shrink-0 rounded-sm overflow-hidden cleo-texture-checker', className)}
      style={{ width: size, height: size }}
      title={title}
    >
      {src && (
        <span
          style={{
            width: r.w * scale,
            height: r.h * scale,
            backgroundImage: `url("${src}")`,
            backgroundRepeat: 'no-repeat',
            backgroundSize: `${asset.imageWidth * scale}px ${asset.imageHeight * scale}px`,
            backgroundPosition: `${-r.x * scale}px ${-r.y * scale}px`,
            imageRendering: 'pixelated',
          }}
        />
      )}
    </span>
  )
}

export interface TilePreviewProps {
  asset: TilesetAsset
  /** The tile shown. Its animation, when it has one, plays. */
  index: number
  size?: number
  className?: string
}

/**
 * The tile being edited as it will draw: its animation playing at its FPS, multiplied by its tint, at its
 * opacity, brightened by its overdrive (a stand-in — the glow itself comes from bloom, in the scene).
 */
export function TilePreview({ asset, index, size = 72, className }: TilePreviewProps) {
  const image = useAtlasImage(asset.textureId)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const meta = asset.tiles[index]
  const frames = meta?.animation && meta.animation.frames.length > 1 ? meta.animation.frames : [index]
  const fps = Math.max(1, meta?.animation?.fps ?? 8)
  const framesKey = frames.join(',')
  const [step, setStep] = useState(0)

  useEffect(() => {
    setStep(0)
    if (frames.length < 2) return
    const id = window.setInterval(() => setStep(s => s + 1), 1000 / fps)
    return () => window.clearInterval(id)
  }, [framesKey, fps]) // keyed on the frame list's content, not its identity: a new array every render

  const shown = frames[step % frames.length]
  const r = tileRect(asset, shown)
  const scale = size / Math.max(1, r.w, r.h)
  const w = Math.max(1, Math.round(r.w * scale))
  const h = Math.max(1, Math.round(r.h * scale))
  const tint = meta?.tint
  const tinted = !!tint && (tint[0] !== 1 || tint[1] !== 1 || tint[2] !== 1)
  const overdrive = meta?.overdrive ?? asset.overdrive ?? 1

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (!image) return
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, w, h)
    if (tinted && tint) {
      // Multiply the colour, then put the tile's own alpha back: multiply alone would fill the transparent
      // pixels with the tint too.
      ctx.globalCompositeOperation = 'multiply'
      ctx.fillStyle = `rgb(${Math.round(tint[0] * 255)}, ${Math.round(tint[1] * 255)}, ${Math.round(tint[2] * 255)})`
      ctx.fillRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'destination-in'
      ctx.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, w, h)
      ctx.globalCompositeOperation = 'source-over'
    }
  }, [image, r.x, r.y, r.w, r.h, w, h, tinted, tint?.[0], tint?.[1], tint?.[2]])

  return (
    <span
      className={cn('inline-flex items-center justify-center shrink-0 rounded border border-border cleo-texture-checker', className)}
      style={{ width: size + 8, height: size + 8 }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: w,
          height: h,
          opacity: meta?.opacity ?? 1,
          // Overdrive multiplies LINEAR light; the preview is sRGB, hence the 1/2.2.
          filter: overdrive !== 1 ? `brightness(${Math.pow(Math.max(0, overdrive), 1 / 2.2).toFixed(3)})` : undefined,
        }}
      />
    </span>
  )
}
