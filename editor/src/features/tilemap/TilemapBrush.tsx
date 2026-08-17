import { useEffect, useRef } from 'react'
import {
  Geometry, Material, Model, ModelNode, Raycaster, TilemapNode, cellCorners, cellTile, packCell,
} from 'cleo'
import type { TileEdit } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useHistory } from '../HistoryContext'

interface Props {
  viewportRef: React.RefObject<HTMLDivElement>
}

/**
 * Viewport-mounted tile painting tool. Active only in tilemap mode.
 *
 * Modelled on LandscapeBrush: it owns pointer listeners on the viewport in the CAPTURE phase and suppresses
 * camera movement + click-selection through the existing GIZMO_DRAG_* events. The one structural difference
 * is picking — a tilemap is flat, so instead of marching a heightfield this intersects the ray with the
 * map's own Z plane, which under the 2D orthographic camera is exact.
 */
export default function TilemapBrush({ viewportRef }: Props) {
  const { instance, editorScene, eventEmitter, editorMode, tilemapBrush } = useCleoEngine()
  const { push } = useHistory()
  const paintingRef = useRef(false)
  const cursorRef = useRef<ModelNode | null>(null)
  // Cells already written during this stroke, so a slow drag over one cell does not record it repeatedly.
  const strokeRef = useRef<{ edits: TileEdit[]; label: string } | null>(null)
  // Where a rectangle/stamp drag began, in cell coordinates.
  const anchorRef = useRef<{ col: number; row: number } | null>(null)

  /** A unit square outline as a line loop, scaled per-cell to trace the hovered tile. */
  const buildOutline = (points: number): Geometry => {
    const positions: [number, number, number][] = []
    const normals: [number, number, number][] = []
    const uvs: [number, number][] = []
    const indices: number[] = []
    for (let i = 0; i < points; i++) {
      positions.push([0, 0, 0])
      normals.push([0, 0, 1])
      uvs.push([0, 0])
    }
    for (let i = 0; i < points; i++) indices.push(i, (i + 1) % points)
    return new Geometry(positions, normals, uvs, [], [], indices, false)
  }

  // The cursor is a scene node named with the __editor__ prefix, which is what keeps it out of selection,
  // out of the scene tree and out of every serialization.
  const ensureCursor = (points: number): ModelNode | null => {
    if (!editorScene) return null
    if (cursorRef.current && cursorRef.current.model.geometry.vertexCount === points) return cursorRef.current
    cursorRef.current?.remove()
    const node = new ModelNode(
      '__editor__tilemapCursor',
      new Model(buildOutline(points), Material.Basic({ color: [1, 0.9, 0.2] }, { wireframe: true, castShadow: false })),
    )
    node.visible = false
    editorScene.addNode(node)
    cursorRef.current = node
    return node
  }

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !instance) return

    const activeTilemap = (): TilemapNode | null => {
      const list = Array.from(editorScene.tilemaps) as TilemapNode[]
      const id = tilemapBrush.current.activeTilemapId
      if (id) { const found = list.find(t => t.id === id); if (found) return found }
      return list[0] ?? null
    }

    const cellAt = (clientX: number, clientY: number): { node: TilemapNode; col: number; row: number } | null => {
      const cam = instance.scene?.activeCamera?.camera
      if (!cam) return null
      const node = activeTilemap()
      if (!node) return null
      // The map's origin is normally refreshed by its per-frame update, which the editor never runs
      // (Scene.update only ticks nodes once the scene has started) — so sync it here, or every cell this
      // picks would be offset by however far the node has been moved.
      node.tilemap.setOrigin(node.worldPosition)
      const rect = viewport.getBoundingClientRect()
      const ray = Raycaster.screenToRay(clientX - rect.left, clientY - rect.top, rect.width, rect.height, cam)
      const planeZ = node.worldPosition[2]
      const dz = ray.direction[2]
      // A ray parallel to the tile plane never meets it. Only reachable if the user has rotated the editor
      // camera to look along the plane, which 2D mode does not do — but a 3D scene holding a tilemap can.
      if (Math.abs(dz) < 1e-6) return null
      const t = (planeZ - ray.origin[2]) / dz
      if (t < 0) return null
      const x = ray.origin[0] + ray.direction[0] * t
      const y = ray.origin[1] + ray.direction[1] * t
      const [col, row] = node.tilemap.worldToCell(x, y)
      return { node, col, row }
    }

    const showCursor = (node: TilemapNode, col: number, row: number, w = 1, h = 1) => {
      const grid = node.tilemap.grid
      // A hex/diamond cell traces its real outline; a rectangular selection traces the block instead, which
      // is what makes a stamp or a rect drag legible.
      const block = w > 1 || h > 1 || grid.kind === 'orthogonal'
      const corners = block ? null : cellCorners(grid, col, row)
      const points = corners ? corners.length / 2 : 4
      const cursor = ensureCursor(points)
      if (!cursor) return
      // Written in place: `positions` is the geometry's live buffer, and the cursor node is rebuilt
      // whenever the point count changes, so the length always matches. (Mutating positions leaves the
      // geometry's memoized BVH stale, which is harmless here — the raycaster skips __editor__ nodes.)
      const geometry = cursor.model.geometry
      const positions = geometry.positions
      positions.fill(0)
      const origin = node.tilemap.origin
      if (corners) {
        for (let i = 0; i < points; i++) {
          positions[i * 3] = corners[i * 2] - origin[0]
          positions[i * 3 + 1] = corners[i * 2 + 1] - origin[1]
        }
      } else {
        const [cx, cy] = node.tilemap.cellToWorld(col, row)
        const left = cx - origin[0] - grid.cellWidth / 2
        const top = cy - origin[1] + grid.cellHeight / 2
        const right = left + w * grid.cellWidth
        const bottom = top - h * grid.cellHeight
        const pts: [number, number][] = [[left, bottom], [right, bottom], [right, top], [left, top]]
        pts.forEach(([px, py], i) => { positions[i * 3] = px; positions[i * 3 + 1] = py })
      }
      if (cursor.initialized) cursor.model.mesh.updateVertexData(geometry.getData(['position', 'normal', 'uv']))
      cursor.setPosition([origin[0], origin[1], origin[2] + 0.02])
      cursor.visible = true
    }
    const hideCursor = () => { if (cursorRef.current) cursorRef.current.visible = false }

    /** Every cell the current stamp covers, anchored at (col,row). */
    const stampCells = (col: number, row: number): { col: number; row: number; tile: number }[] => {
      const { stamp } = tilemapBrush.current
      const out: { col: number; row: number; tile: number }[] = []
      for (let r = 0; r < stamp.h; r++)
        for (let c = 0; c < stamp.w; c++) {
          const tile = stamp.tiles[r * stamp.w + c]
          if (tile === undefined || tile < 0) continue
          out.push({ col: col + c, row: row + r, tile })
        }
      return out
    }

    const paint = (node: TilemapNode, col: number, row: number) => {
      const b = tilemapBrush.current
      const map = node.tilemap
      const layer = b.activeLayer
      const orient = b.orient
      switch (b.tool) {
        case 'eraser':
          map.eraseTile(layer, col, row)
          break
        case 'bucket':
          map.bucketFill(layer, col, row, b.stamp.tiles[0] ?? 0, orient)
          break
        case 'autotile':
          if (b.terrainId !== null) map.applyAutoTile(layer, col, row, b.terrainId)
          break
        case 'randomize':
          if (b.variantSetId !== null) map.applyVariant(layer, col, row, b.variantSetId, orient)
          break
        case 'stamp':
          for (const cell of stampCells(col, row)) map.setTile(layer, cell.col, cell.row, cell.tile, orient)
          break
        case 'brush':
        default:
          map.setTile(layer, col, row, b.stamp.tiles[0] ?? 0, orient)
          break
      }
    }

    /** Preview + commit for the drag-a-rectangle tool. */
    const fillRect = (node: TilemapNode, a: { col: number; row: number }, b2: { col: number; row: number }) => {
      const b = tilemapBrush.current
      node.tilemap.fillRect(b.activeLayer, a.col, a.row, b2.col, b2.row, b.stamp.tiles[0] ?? 0, b.orient)
    }

    // The brush listens in the capture phase on the viewport, which is an ancestor of the floating tool
    // card — without this a click on a control there would start a stroke and never reach the control.
    const inOverlay = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('[data-cleo-overlay]')

    const beginStroke = (label: string) => {
      strokeRef.current = { edits: [], label }
    }

    /** Run `fn` collecting its cell writes, and append them to the open stroke's diff. */
    const record = (node: TilemapNode, fn: () => void) => {
      const { edits } = node.tilemap.recordEdits(fn)
      if (strokeRef.current) strokeRef.current.edits.push(...edits)
    }

    const endStroke = (node: TilemapNode | null) => {
      const stroke = strokeRef.current
      strokeRef.current = null
      anchorRef.current = null
      if (!stroke || stroke.edits.length === 0 || !node) return
      const map = node.tilemap
      const edits = stroke.edits
      push({
        label: stroke.label,
        undo: () => { map.applyEdits(edits, true); eventEmitter.emit('SCENE_CHANGED') },
        redo: () => { map.applyEdits(edits, false); eventEmitter.emit('SCENE_CHANGED') },
      })
      eventEmitter.emit('SCENE_CHANGED')
    }

    const onDown = (e: MouseEvent) => {
      if (editorMode !== 'tilemap' || e.button !== 0) return
      if (inOverlay(e.target)) return
      const hit = cellAt(e.clientX, e.clientY)
      if (!hit) return
      const b = tilemapBrush.current

      // The eyedropper reads rather than writes, so it neither opens a stroke nor suppresses the camera.
      if (b.tool === 'eyedropper') {
        const tile = cellTile(hit.node.tilemap.getPacked(b.activeLayer, hit.col, hit.row))
        if (tile >= 0) {
          b.stamp = { w: 1, h: 1, tiles: [tile] }
          b.tool = 'brush'
          eventEmitter.emit('TILEMAP_BRUSH_CHANGED')
        }
        e.preventDefault(); e.stopPropagation()
        return
      }

      paintingRef.current = true
      eventEmitter.emit('GIZMO_DRAG_START', { axis: 'tilemap', nodeId: hit.node.id })
      beginStroke(TOOL_LABEL[b.tool] ?? 'Paint tiles')

      if (b.tool === 'rect') anchorRef.current = { col: hit.col, row: hit.row }
      else record(hit.node, () => paint(hit.node, hit.col, hit.row))

      showCursor(hit.node, hit.col, hit.row)
      e.preventDefault()
      e.stopPropagation()
    }

    const onMove = (e: MouseEvent) => {
      if (editorMode !== 'tilemap') return
      if (!paintingRef.current && inOverlay(e.target)) { hideCursor(); return }
      const hit = cellAt(e.clientX, e.clientY)
      if (!hit) { if (!paintingRef.current) hideCursor(); return }

      const b = tilemapBrush.current
      const anchor = anchorRef.current
      if (paintingRef.current && b.tool !== 'rect') record(hit.node, () => paint(hit.node, hit.col, hit.row))

      if (anchor) {
        showCursor(hit.node,
          Math.min(anchor.col, hit.col), Math.min(anchor.row, hit.row),
          Math.abs(hit.col - anchor.col) + 1, Math.abs(hit.row - anchor.row) + 1)
      } else {
        showCursor(hit.node, hit.col, hit.row, b.stamp.w, b.stamp.h)
      }
    }

    const onUp = (e: MouseEvent) => {
      if (!paintingRef.current) return
      paintingRef.current = false
      const hit = cellAt(e.clientX, e.clientY)
      const anchor = anchorRef.current
      const node = hit?.node ?? activeTilemap()
      // The rectangle is only written on release — painting it live would record every intermediate size.
      if (anchor && hit) record(hit.node, () => fillRect(hit.node, anchor, hit))
      endStroke(node)
      eventEmitter.emit('GIZMO_DRAG_END', { axis: null, nodeId: null })
    }

    // X / Y / Z cycle the orientation the brush places, the way every tile editor binds them.
    const onKey = (e: KeyboardEvent) => {
      if (editorMode !== 'tilemap' || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      const b = tilemapBrush.current
      if (e.key === 'x' || e.key === 'X') b.orient = { ...b.orient, flipX: !b.orient.flipX }
      else if (e.key === 'y' || e.key === 'Y') b.orient = { ...b.orient, flipY: !b.orient.flipY }
      else if (e.key === 'z' || e.key === 'Z') b.orient = { ...b.orient, rot90: !b.orient.rot90 }
      else return
      eventEmitter.emit('TILEMAP_BRUSH_CHANGED')
      e.preventDefault()
    }

    if (editorMode !== 'tilemap') hideCursor()

    viewport.addEventListener('mousedown', onDown, true)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      viewport.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [instance, editorScene, eventEmitter, editorMode, tilemapBrush, viewportRef, push])

  // Drop the cursor when the mode is left, so it cannot linger over the scene view.
  useEffect(() => () => { cursorRef.current?.remove(); cursorRef.current = null }, [])

  return null
}

const TOOL_LABEL: Record<string, string> = {
  brush: 'Paint tiles',
  eraser: 'Erase tiles',
  rect: 'Fill rectangle',
  bucket: 'Bucket fill',
  stamp: 'Stamp tiles',
  randomize: 'Scatter tiles',
  autotile: 'Auto-tile',
}
