import { useEffect, useState } from 'react'
import type { Scene, VolumetricCloudsNode } from 'cleo'
import { useEventBus } from '../features/EventBusContext'

type Vec3 = [number, number, number]

/**
 * The direction TOWARD the sun that the scene's sky — and so a cloud-sky bake — is lit by: the Sky
 * Atmosphere's own sun when it overrides the scene light, else the first directional light.
 */
export function sceneSunDir(scene: Scene | null): Vec3 | null {
  if (!scene) return null
  const atmo = scene.skyAtmosphere
  if (atmo && !atmo.useSceneSun) {
    const d = atmo.sunDirection
    const len = Math.hypot(d[0], d[1], d[2]) || 1
    return [d[0] / len, d[1] / len, d[2] / len]
  }
  for (const light of scene.lights) {
    if (light.type !== 'directional') continue
    const f = light.worldForward
    const len = Math.hypot(f[0], f[1], f[2]) || 1
    return [-f[0] / len, -f[1] / len, -f[2] / len]
  }
  return null
}

export interface CloudBakeStatus {
  /** Clouds that bake into the sky, or null when the scene has none (or they do not bake). */
  clouds: VolumetricCloudsNode | null
  /** The bake needs a Sky Atmosphere to paint over. */
  hasAtmosphere: boolean
  staleness: ReturnType<VolumetricCloudsNode['bakeStaleness']>
  /** Seconds since the current bake, or null before one. */
  age: number | null
}

/**
 * Live status of the scene's cloud-sky bake. Re-read on every SCENE_CHANGED (a light rotating, a
 * cloud field edited) and on a slow poll, because the bake itself lands on a render frame, not on an
 * editor event.
 */
export function useCloudBakeStatus(scene: Scene | null): CloudBakeStatus {
  const eventEmitter = useEventBus()
  const read = (): CloudBakeStatus => {
    const node = scene?.volumetricClouds ?? null
    const clouds = node && node.bakeIntoSky ? node : null
    return {
      clouds,
      hasAtmosphere: !!scene?.skyAtmosphere,
      staleness: clouds ? clouds.bakeStaleness(sceneSunDir(scene)) : 'none',
      age: clouds?.bakedSunDir ? performance.now() * 0.001 - clouds.bakedAt : null,
    }
  }
  const [status, setStatus] = useState<CloudBakeStatus>(read)
  useEffect(() => {
    const refresh = () => setStatus(read())
    refresh()
    eventEmitter.on('SCENE_CHANGED', refresh)
    const id = window.setInterval(refresh, 1000)
    return () => { eventEmitter.off('SCENE_CHANGED', refresh); window.clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventEmitter, scene])
  return status
}

/** "12 s ago" / "3 min ago" for the bake status line. */
export function formatBakeAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  return `${Math.round(seconds / 3600)} h ago`
}

/** The one-line warning for a stale bake, or null when it is current (or there is none yet). */
export function cloudBakeWarning(staleness: CloudBakeStatus['staleness']): string | null {
  if (staleness === 'sun') return 'The sun has moved since the clouds were baked into the sky — Regenerate.'
  if (staleness === 'settings') return 'The cloud settings changed since the bake — Regenerate.'
  return null
}
