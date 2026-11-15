// What each optional feature weighs in a published game, from the prebuilt player's build.json: the shader
// modules only it draws with (each one's base program, its GLSL included unless the game is WebGPU-only) and
// any player chunks of its own. Variants are left out: which ones a game ships depends on what it draws.
import { useEffect, useState } from 'react'
import { FEATURES } from 'cleo'
import type { PlayerBuild } from '../publish/playerManifest'

export interface FeatureSizes {
  /** What leaving each feature out saves, in bytes: WebGL 2 shaders included, and without them. */
  readonly byFeature: Readonly<Record<string, { all: number; webgpuOnly: number }>>;
  /** The engine every game ships: the player's core files and the shaders no feature owns. */
  readonly core: { all: number; webgpuOnly: number };
  /** The GLSL of every module: what WebGPU-only drops, with nothing else off. */
  readonly glsl: number;
  /** The physics backends' chunks, by backend. */
  readonly physics: Readonly<Record<string, number>>;
}

/** Sizes from a player build (pure, for tests). Null for a build without a shader library (older player). */
export function featureSizesFrom(build: PlayerBuild): FeatureSizes | null {
  const modules = build.shaders?.modules
  if (!modules) return null
  const owned = new Set<string>()
  const byFeature: Record<string, { all: number; webgpuOnly: number }> = {}
  for (const f of FEATURES) {
    let all = 0, glsl = 0
    for (const id of f.shaderModules ?? []) {
      const m = modules[id]
      if (!m) continue
      owned.add(id)
      all += m.bytes
      glsl += m.glslBytes
    }
    byFeature[f.id] = { all, webgpuOnly: all - glsl }
  }
  let coreAll = build.coreBytes, coreGlsl = 0, glsl = 0
  for (const [id, m] of Object.entries(modules)) {
    glsl += m.glslBytes
    if (owned.has(id)) continue
    coreAll += m.bytes
    coreGlsl += m.glslBytes
  }
  byFeature.webgl2 = { all: glsl, webgpuOnly: glsl }
  const physics: Record<string, number> = { cannon: 0 }
  for (const [id, part] of Object.entries(build.features)) {
    const backend = id.match(/^physics-(\w+)$/)?.[1]
    if (backend) physics[backend] = part.bytes
  }
  return { byFeature, core: { all: coreAll, webgpuOnly: coreAll - coreGlsl }, glsl, physics }
}

/**
 * About how much engine a game with these features downloads: the core, each feature on, the physics backend.
 * Its own data (game.bin: scenes, meshes, textures) and the shader variants it draws with come on top.
 */
export function engineEstimate(sizes: FeatureSizes, enabled: ReadonlySet<string>, webgl2: boolean, backend: string): number {
  const pick = (s: { all: number; webgpuOnly: number }) => webgl2 ? s.all : s.webgpuOnly
  let total = pick(sizes.core) + (sizes.physics[backend] ?? 0)
  for (const f of FEATURES) if (f.id !== 'webgl2' && enabled.has(f.id)) total += pick(sizes.byFeature[f.id] ?? { all: 0, webgpuOnly: 0 })
  return total
}

/** "1.4 MB", "86 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${bytes} B`
}

let cached: Promise<FeatureSizes | null> | null = null

/** The served player's sizes (null without one: `npm run build:player`). Fetched once per session. */
export function useFeatureSizes(): FeatureSizes | null {
  const [sizes, setSizes] = useState<FeatureSizes | null>(null)
  useEffect(() => {
    let live = true
    cached ??= fetch('player/build.json')
      .then(r => (r.ok ? r.json() : null))
      .then(build => (build ? featureSizesFrom(build as PlayerBuild) : null))
      .catch(() => null)
    cached.then(s => { if (live) setSizes(s) })
    return () => { live = false }
  }, [])
  return sizes
}
