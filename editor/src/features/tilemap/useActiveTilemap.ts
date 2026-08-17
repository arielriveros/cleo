import { useCallback, useEffect, useState } from 'react'
import { TilemapNode } from 'cleo'
import { useCleoEngine } from '../EngineContext'

// Which tilemap the tilemap-mode panels act on, and a re-render trigger for its (non-React) contents.
//
// A Tilemap is plain engine state, so nothing about editing it re-renders React on its own. Every panel
// here polls the map's `version` counter on the scene bus instead of trying to mirror the grid into state,
// which would mean copying thousands of cells on every stroke.

export function useActiveTilemap(): {
  node: TilemapNode | null
  tilemaps: TilemapNode[]
  select: (id: string) => void
  /** Bumped whenever the scene changes or the map is painted; use it as a render dependency. */
  revision: number
  refresh: () => void
} {
  const { editorScene, eventEmitter, tilemapBrush } = useCleoEngine()
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(r => r + 1), [])

  useEffect(() => {
    eventEmitter.on('SCENE_CHANGED', refresh)
    eventEmitter.on('TILEMAP_BRUSH_CHANGED', refresh)
    return () => {
      eventEmitter.off('SCENE_CHANGED', refresh)
      eventEmitter.off('TILEMAP_BRUSH_CHANGED', refresh)
    }
  }, [eventEmitter, refresh])

  // A paint stroke mutates the map without touching the scene graph, so nothing on the bus fires. Poll the
  // map's version instead — cheap (one integer compare) and it keeps the palette/layer counts honest while
  // the user drags.
  const tilemaps = Array.from(editorScene.tilemaps) as TilemapNode[]
  const active = tilemaps.find(t => t.id === tilemapBrush.current.activeTilemapId) ?? tilemaps[0] ?? null
  useEffect(() => {
    if (!active) return
    let last = active.tilemap.version
    const timer = window.setInterval(() => {
      if (active.tilemap.version === last) return
      last = active.tilemap.version
      refresh()
    }, 200)
    return () => window.clearInterval(timer)
  }, [active, refresh])

  const select = useCallback((id: string) => {
    tilemapBrush.current.activeTilemapId = id
    eventEmitter.emit('TILEMAP_BRUSH_CHANGED')
  }, [tilemapBrush, eventEmitter])

  return { node: active, tilemaps, select, revision, refresh }
}
