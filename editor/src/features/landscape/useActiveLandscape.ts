import { useCallback, useEffect, useState } from 'react'
import { LandscapeNode } from 'cleo'
import { useCleoEngine } from '../EngineContext'

// Which landscape the landscape-mode panels act on, plus a re-render trigger for its non-React contents:
// a Terrain is plain engine state, so panels take `revision` as a dependency and re-read what they need.

export function useActiveLandscape(): {
  node: LandscapeNode | null
  landscapes: LandscapeNode[]
  select: (id: string) => void
  /** Bumped whenever the scene changes or the brush settings change; use it as a render dependency. */
  revision: number
  refresh: () => void
} {
  const { editorScene, eventEmitter, terrainBrush } = useCleoEngine()
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(r => r + 1), [])

  useEffect(() => {
    eventEmitter.on('SCENE_CHANGED', refresh)
    eventEmitter.on('TERRAIN_BRUSH_CHANGED', refresh)
    return () => {
      eventEmitter.off('SCENE_CHANGED', refresh)
      eventEmitter.off('TERRAIN_BRUSH_CHANGED', refresh)
    }
  }, [eventEmitter, refresh])

  const landscapes = Array.from(editorScene.landscapes) as LandscapeNode[]
  const active = landscapes.find(l => l.id === terrainBrush.current.activeLandscapeId) ?? landscapes[0] ?? null

  const select = useCallback((id: string) => {
    terrainBrush.current.activeLandscapeId = id
    eventEmitter.emit('TERRAIN_BRUSH_CHANGED')
  }, [terrainBrush, eventEmitter])

  return { node: active, landscapes, select, revision, refresh }
}
