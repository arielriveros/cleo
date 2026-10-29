import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button, cn } from '../../components/ui'
import { token } from '../../utils/cssTokens'
import type { TilesetAsset } from '../../utils/tilesets'
import { awaitTextureImage, textureImage } from '../../utils/textureReady'
import { clamp } from '../../utils/math';

// The atlas with its slicing grid drawn over it, plus rectangular selection. Shared by the tileset editor
// (picking the tile being edited) and the tilemap palette (picking the brush, a rectangle being a stamp).
// The image is an <img>, not a canvas draw, so `image-rendering: pixelated` works at any zoom; only the
// grid, the metadata markers and the selection are drawn on a canvas over the top.

export type TileRect = { col: number; row: number; w: number; h: number }

export interface TileGridProps {
  asset: TilesetAsset
  /** Selected tile indices. */
  selection: number[]
  /** Fired on selection change. `rect` is present for a drag, and is what a multi-tile stamp is built from. */
  onSelect: (indices: number[], rect: TileRect) => void
  /** Allow dragging out a rectangle. Single-click selection only when false. */
  rectSelect?: boolean
  zoom?: number
  onZoomChange?: (zoom: number) => void
  /** Extra badge colour per tile, e.g. to mark solid or animated tiles. */
  markerOf?: (index: number) => string | null
  /** Shown as a call to action on the empty state, when the tileset has no atlas yet. */
  onImport?: () => void
  /**
   * Text drawn in a tile's bottom-left corner — the frame numbers of the animation being edited, so the
   * atlas shows which tiles play and in what order.
   */
  badges?: ReadonlyMap<number, string>
  /** A tile outlined as the subject of the current operation (the tile whose animation is being picked). */
  anchor?: number | null
  /** Right-click on a cell. The browser menu is suppressed only when this is given. */
  onCellContextMenu?: (index: number) => void
  /** Cursor over the atlas. Crosshair by default. */
  cursor?: string
  className?: string
}

// Read from the design tokens at draw time, never at module scope (index.css is not applied yet then).
const gridColor = () => token('--text', 0.22)
const selectFill = () => token('--highlight', 0.28)
const selectStroke = () => token('--highlight', 0.95)
const anchorStroke = () => token('--warning', 0.95)
const badgeFill = () => token('--surface-sunken', 0.85)
const badgeText = () => token('--warning')

export default function TileGrid({
  asset, selection, onSelect, rectSelect = true, zoom: zoomProp, onZoomChange, markerOf, onImport,
  badges, anchor, onCellContextMenu, cursor = 'crosshair', className,
}: TileGridProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [internalZoom, setInternalZoom] = useState(1)
  const zoom = zoomProp ?? internalZoom
  const setZoom = onZoomChange ?? setInternalZoom
  /** Where the drag started, in cells. Null when no drag is in progress. */
  const dragRef = useRef<{ col: number; row: number } | null>(null)
  const [drag, setDrag] = useState<TileRect | null>(null)
  /**
   * The live drag rect, mirrored out of state.
   * `onUp` needs the final rect; reading it from inside a `setDrag` updater would put a side effect in a
   * reducer, and React may run an updater more than once, re-firing `onSelect` onto the event bus.
   */
  const dragRectRef = useRef<TileRect | null>(null)

  // Resolved in an effect, not a memo: TextureManager decodes asynchronously, so a just-registered texture
  // has no image yet and a memo would never recompute when the decode landed.
  const [src, setSrc] = useState('')
  useEffect(() => {
    let cancelled = false
    setSrc(textureImage(asset.textureId)?.src ?? '')
    void awaitTextureImage(asset.textureId).then(image => {
      if (!cancelled) setSrc(image?.src ?? '')
    })
    return () => { cancelled = true }
  }, [asset.textureId])

  const width = asset.imageWidth * zoom
  const height = asset.imageHeight * zoom
  const selected = useMemo(() => new Set(selection), [selection])

  // A layout effect, so the grid never lags the image by a frame when the zoom or the slicing changes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const stepX = (asset.tileWidth + asset.spacing) * zoom
    const stepY = (asset.tileHeight + asset.spacing) * zoom
    const tw = asset.tileWidth * zoom
    const th = asset.tileHeight * zoom
    const originX = asset.margin * zoom
    const originY = asset.margin * zoom

    // Grid. One stroke per line rather than per cell: a 4096-tile atlas is ~130 lines, not 4096 rects.
    ctx.lineWidth = 1
    ctx.strokeStyle = gridColor()
    ctx.beginPath()
    for (let c = 0; c <= asset.columns; c++) {
      const x = Math.round(originX + c * stepX) + 0.5
      ctx.moveTo(x, originY)
      ctx.lineTo(x, originY + asset.rows * stepY)
      if (asset.spacing > 0 && c < asset.columns) {
        const x2 = Math.round(originX + c * stepX + tw) + 0.5
        ctx.moveTo(x2, originY)
        ctx.lineTo(x2, originY + asset.rows * stepY)
      }
    }
    for (let r = 0; r <= asset.rows; r++) {
      const y = Math.round(originY + r * stepY) + 0.5
      ctx.moveTo(originX, y)
      ctx.lineTo(originX + asset.columns * stepX, y)
      if (asset.spacing > 0 && r < asset.rows) {
        const y2 = Math.round(originY + r * stepY + th) + 0.5
        ctx.moveTo(originX, y2)
        ctx.lineTo(originX + asset.columns * stepX, y2)
      }
    }
    ctx.stroke()

    if (markerOf) {
      const size = clamp(tw * 0.25, 3, 6)
      for (let i = 0; i < asset.columns * asset.rows; i++) {
        const colour = markerOf(i)
        if (!colour) continue
        const c = i % asset.columns, r = Math.floor(i / asset.columns)
        ctx.fillStyle = colour
        ctx.fillRect(originX + c * stepX + tw - size - 1, originY + r * stepY + 1, size, size)
      }
    }

    const SELECT_FILL = selectFill()
    const SELECT_STROKE = selectStroke()
    const paint = (col: number, row: number, w: number, h: number) => {
      const x = originX + col * stepX
      const y = originY + row * stepY
      const rw = (w - 1) * stepX + tw
      const rh = (h - 1) * stepY + th
      ctx.fillStyle = SELECT_FILL
      ctx.fillRect(x, y, rw, rh)
      ctx.strokeStyle = SELECT_STROKE
      ctx.lineWidth = 2
      ctx.strokeRect(x + 1, y + 1, rw - 2, rh - 2)
    }

    if (drag) paint(drag.col, drag.row, drag.w, drag.h)
    else for (const i of selected) {
      if (i < 0 || i >= asset.columns * asset.rows) continue
      paint(i % asset.columns, Math.floor(i / asset.columns), 1, 1)
    }

    if (anchor !== null && anchor !== undefined && anchor >= 0 && anchor < asset.columns * asset.rows) {
      const x = originX + (anchor % asset.columns) * stepX
      const y = originY + Math.floor(anchor / asset.columns) * stepY
      ctx.strokeStyle = anchorStroke()
      ctx.lineWidth = 2
      ctx.setLineDash([4, 3])
      ctx.strokeRect(x + 1, y + 1, tw - 2, th - 2)
      ctx.setLineDash([])
    }

    if (badges && badges.size > 0) {
      // Sized to the cell but never unreadable: a 16px tile at 100% still gets a 9px label.
      const font = clamp(Math.round(th * 0.32), 9, 14)
      ctx.font = `600 ${font}px ui-sans-serif, system-ui, sans-serif`
      ctx.textBaseline = 'bottom'
      for (const [i, text] of badges) {
        if (i < 0 || i >= asset.columns * asset.rows) continue
        const x = originX + (i % asset.columns) * stepX
        const y = originY + Math.floor(i / asset.columns) * stepY
        const w = Math.min(tw - 2, ctx.measureText(text).width + 6)
        ctx.fillStyle = badgeFill()
        ctx.fillRect(x + 1, y + th - font - 3, w, font + 2)
        ctx.fillStyle = badgeText()
        ctx.save()
        ctx.beginPath(); ctx.rect(x + 1, y, tw - 2, th); ctx.clip()
        ctx.fillText(text, x + 4, y + th - 1)
        ctx.restore()
      }
    }
  }, [asset, zoom, width, height, selected, drag, markerOf, badges, anchor])

  const cellAt = (e: React.MouseEvent): { col: number; row: number } | null => {
    const wrap = wrapRef.current
    if (!wrap) return null
    const rect = wrap.getBoundingClientRect()
    const px = (e.clientX - rect.left) / zoom - asset.margin
    const py = (e.clientY - rect.top) / zoom - asset.margin
    const col = Math.floor(px / (asset.tileWidth + asset.spacing))
    const row = Math.floor(py / (asset.tileHeight + asset.spacing))
    if (col < 0 || row < 0 || col >= asset.columns || row >= asset.rows) return null
    return { col, row }
  }

  const emit = (rect: TileRect) => {
    const indices: number[] = []
    for (let r = 0; r < rect.h; r++)
      for (let c = 0; c < rect.w; c++) indices.push((rect.row + r) * asset.columns + rect.col + c)
    onSelect(indices, rect)
  }
  // Behind a ref so the window listener below can register ONCE: `emit` closes over `asset` and the
  // `onSelect` prop, both of which change identity on most renders.
  const emitRef = useRef(emit)
  emitRef.current = emit

  const setDragRect = (rect: TileRect | null) => {
    dragRectRef.current = rect
    setDrag(rect)
  }

  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const cell = cellAt(e)
    if (!cell) return
    e.preventDefault()
    if (!rectSelect) { emit({ ...cell, w: 1, h: 1 }); return }
    dragRef.current = cell
    setDragRect({ ...cell, w: 1, h: 1 })
  }

  const onMove = (e: React.MouseEvent) => {
    const start = dragRef.current
    if (!start) return
    const cell = cellAt(e)
    if (!cell) return
    setDragRect({
      col: Math.min(start.col, cell.col),
      row: Math.min(start.row, cell.row),
      w: Math.abs(cell.col - start.col) + 1,
      h: Math.abs(cell.row - start.row) + 1,
    })
  }

  // On window rather than the element: a drag that leaves the grid must still finish. Registered once —
  // everything it touches is a ref.
  useEffect(() => {
    const onUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      const rect = dragRectRef.current
      setDragRect(null)
      // AFTER the state write, never inside its updater: emit() reaches the event bus and sets state in
      // other components.
      if (rect) emitRef.current(rect)
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [])

  const onContextMenu = (e: React.MouseEvent) => {
    if (!onCellContextMenu) return
    e.preventDefault()
    const cell = cellAt(e)
    if (cell) onCellContextMenu(cell.row * asset.columns + cell.col)
  }

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    setZoom(clamp(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.25, 16))
  }

  if (!src) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 text-ui text-muted', className)}>
        <p>This tileset has no atlas image.</p>
        {onImport
          ? <Button size='sm' onClick={onImport}>Import image…</Button>
          : <p>Drop one onto its Atlas slot.</p>}
      </div>
    )
  }

  return (
    <div className={cn('overflow-auto', className)} onWheel={onWheel}>
      <div
        ref={wrapRef}
        className='relative select-none'
        style={{ width, height, cursor }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onContextMenu={onContextMenu}
      >
        <img
          src={src}
          alt=''
          draggable={false}
          style={{ width, height, imageRendering: 'pixelated', display: 'block' }}
        />
        <canvas ref={canvasRef} className='absolute inset-0 pointer-events-none' style={{ width, height }} />
      </div>
    </div>
  )
}
