import { useEffect, useMemo, useRef, useState } from 'react'
import { TextureManager } from 'cleo'
import { buildMipChain, isolateChannel, texelAt, type Channel } from './mipChain'
import type { TextureSettings, WrapMode } from '../../utils/textureAssets'

// The 2D viewer. Draws the decoded image itself rather than the GPU texture, so it works with no render
// pass and no device — but it MIRRORS the authored settings, which is what makes them legible:
//
//   magFilter -> imageSmoothingEnabled, so nearest vs linear is honest the moment you zoom in
//   wrapU/V   -> the tiling preview, which is the clearest demonstration of per-axis wrap there is
//   mipMap    -> the level stepper, over a chain filtered the way the GPU filters it
//
// What it CANNOT show is anisotropy and mip transitions: both are properties of a perspective view of a
// surface, and there is no surface here. The panel says so rather than implying otherwise.

type Props = {
  textureId: string
  settings: TextureSettings
  channel: Channel
  level: number
  tile: number
  zoom: number
  onZoom: (z: number) => void
  onLevels: (n: number) => void
}

/** One tile of the repeat, flipped per wrap mode. Clamp draws only the first tile and stretches its edge. */
function tileTransform(mode: WrapMode, index: number): { flip: boolean; draw: boolean } {
  if (index === 0) return { flip: false, draw: true }
  if (mode === 'clamp') return { flip: false, draw: false }
  return { flip: mode === 'mirror' && index % 2 === 1, draw: true }
}

export default function TextureCanvas(props: Props) {
  const { textureId, settings, channel, level, tile, zoom, onZoom, onLevels } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [probe, setProbe] = useState<{ x: number; y: number; rgba: [number, number, number, number] } | null>(null)
  const [generation, setGeneration] = useState(0)

  // The decoded image lives on the live Texture. It arrives asynchronously with no callback, so a texture
  // opened before its bytes have decoded is polled for rather than missed entirely.
  const image = useMemo(() => {
    const data = TextureManager.Instance.getTexture(textureId)?.data
    return data instanceof HTMLImageElement && data.complete && data.naturalWidth ? data : null
  }, [textureId, generation])

  useEffect(() => {
    if (image) return
    const timer = window.setInterval(() => setGeneration(g => g + 1), 120)
    return () => window.clearInterval(timer)
  }, [image])

  const chain = useMemo(() => (image ? buildMipChain(image) : []), [image])
  useEffect(() => { onLevels(chain.length) }, [chain.length, onLevels])

  const shown = useMemo(() => {
    const source = chain[Math.min(level, Math.max(0, chain.length - 1))]
    return source ? isolateChannel(source, channel) : null
  }, [chain, level, channel])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !shown) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Level 0's dimensions, not the current level's: stepping the mip must shrink the picture on screen
    // the way a mip chain actually shrinks, instead of rescaling every level to the same box.
    const base = chain[0]
    const scale = zoom * (shown.width / base.width)
    const tw = Math.max(1, Math.round(base.width * zoom))
    const th = Math.max(1, Math.round(base.height * zoom))

    canvas.width = tw * tile
    canvas.height = th * tile
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // Mirrors the authored magnification filter, so nearest really does look nearest when zoomed in.
    ctx.imageSmoothingEnabled = settings.magFilter === 'linear'
    ctx.imageSmoothingQuality = 'high'

    const dw = Math.max(1, Math.round(shown.width * scale))
    const dh = Math.max(1, Math.round(shown.height * scale))

    for (let ty = 0; ty < tile; ty++) {
      for (let tx = 0; tx < tile; tx++) {
        const u = tileTransform(settings.wrapU, tx)
        const v = tileTransform(settings.wrapV, ty)
        const x = tx * tw
        const y = ty * th
        if (!u.draw || !v.draw) {
          // Clamp: the border texel is what a sampler returns past the edge, so stretch it across the tile.
          const sx = u.draw ? 0 : (settings.wrapU === 'clamp' ? shown.width - 1 : 0)
          const sy = v.draw ? 0 : (settings.wrapV === 'clamp' ? shown.height - 1 : 0)
          ctx.drawImage(shown, u.draw ? 0 : sx, v.draw ? 0 : sy,
                        u.draw ? shown.width : 1, v.draw ? shown.height : 1,
                        x, y, u.draw ? dw : tw, v.draw ? dh : th)
          continue
        }
        ctx.save()
        ctx.translate(x + (u.flip ? dw : 0), y + (v.flip ? dh : 0))
        ctx.scale(u.flip ? -1 : 1, v.flip ? -1 : 1)
        ctx.drawImage(shown, 0, 0, dw, dh)
        ctx.restore()
      }
    }
  }, [shown, chain, zoom, tile, settings.magFilter, settings.wrapU, settings.wrapV])

  if (!image) {
    return (
      <div className='flex-1 flex items-center justify-center text-xs text-muted'>
        Decoding image…
      </div>
    )
  }

  return (
    <div
      ref={wrapRef}
      className='flex-1 overflow-auto p-3 cleo-texture-checker'
      onWheel={(e) => {
        if (!e.ctrlKey) return
        e.preventDefault()
        onZoom(Math.min(32, Math.max(0.05, zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2))))
      }}
      onMouseLeave={() => setProbe(null)}
    >
      <canvas
        ref={canvasRef}
        className='block'
        style={{ imageRendering: settings.magFilter === 'nearest' ? 'pixelated' : 'auto' }}
        onMouseMove={(e) => {
          const source = chain[Math.min(level, Math.max(0, chain.length - 1))]
          if (!source) return
          const rect = e.currentTarget.getBoundingClientRect()
          const base = chain[0]
          // Screen -> texel of the CURRENT level, through the same scale the draw used.
          const scale = zoom * (source.width / base.width)
          const x = Math.floor(((e.clientX - rect.left) % Math.max(1, base.width * zoom)) / scale)
          const y = Math.floor(((e.clientY - rect.top) % Math.max(1, base.height * zoom)) / scale)
          const rgba = texelAt(source, x, y)
          setProbe(rgba ? { x, y, rgba } : null)
        }}
      />
      {probe && (
        <div className='sticky bottom-0 left-0 mt-2 inline-flex items-center gap-2 rounded bg-surface/90 px-2 py-1 text-[11px] text-muted'>
          <span
            className='inline-block h-3 w-3 rounded-sm border border-border'
            style={{ background: `rgb(${probe.rgba[0]} ${probe.rgba[1]} ${probe.rgba[2]})` }}
          />
          <span>{probe.x}, {probe.y}</span>
          <span>rgba({probe.rgba.join(', ')})</span>
        </div>
      )}
    </div>
  )
}
