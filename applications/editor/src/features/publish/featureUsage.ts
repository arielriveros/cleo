// What a game uses of the engine's optional features (src/modules/catalog.ts), read from its serialized scenes,
// templates and scripts: the Features panel's "Detect from project" and the check Publish runs when a project
// has features turned off. Static, like Godot's detection: a node a script builds from a string, or a feature
// reached through another, is not seen. Pure, over serialized JSON.
import { FEATURES, type FeatureDef } from 'cleo'

/** One use of a feature: where it is, and what there uses it. */
export interface FeatureUse {
  /** "Main ▸ World/Landscape", "template Crate", "script /Player/Hero", "render settings". */
  readonly where: string;
  /** "Landscape node", "cel material", "imports LandscapeNode", "ssrEnabled". */
  readonly what: string;
}

/** Uses by feature id; a feature nothing uses is absent. */
export type FeatureUsage = Map<string, FeatureUse[]>;

/** The parts of a game the scan reads: what buildMultiSceneGameData produces, scripts still on their nodes. */
export interface UsageSource {
  /** `dimension`: a 2D scene draws through the flat 2D frame, which runs none of the 3D render settings. */
  scenes: Record<string, { name: string; scene: any; render?: any; dimension?: '2D' | '3D' }>;
  templates?: { name?: string; node: any }[];
  /** Script module sources, by module id. */
  modules?: Record<string, string>;
  config?: { render?: any; input?: any };
}

const NODE_FEATURE = new Map<string, FeatureDef>()
const MATERIAL_FEATURE = new Map<string, FeatureDef>()
for (const f of FEATURES) {
  for (const t of f.nodeTypes ?? []) NODE_FEATURE.set(t, f)
  for (const m of f.materialTypes ?? []) MATERIAL_FEATURE.set(m, f)
}

const label = (type: string) => type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase())

/** Whether `source` imports the engine at all: only then can a feature's name in it be the feature's. */
const importsCleo = (source: string) => /\bfrom\s*['"]cleo['"]|import\s*\(\s*['"]cleo['"]\s*\)|__cleoImport\(\s*['"]cleo['"]/.test(source)

/** The feature names a script uses, by whole word, when it imports the engine. */
function scriptUses(source: string): { feature: FeatureDef; name: string }[] {
  if (typeof source !== 'string' || !importsCleo(source)) return []
  const out: { feature: FeatureDef; name: string }[] = []
  for (const f of FEATURES) for (const name of f.apiNames ?? [])
    if (new RegExp(`\\b${name}\\b`).test(source)) out.push({ feature: f, name })
  return out
}

/** Every use of a feature in `game`. */
export function featureUsage(game: UsageSource): FeatureUsage {
  const usage: FeatureUsage = new Map()
  const add = (f: FeatureDef, where: string, what: string) => {
    let list = usage.get(f.id)
    if (!list) usage.set(f.id, list = [])
    if (!list.some(u => u.where === where && u.what === what)) list.push({ where, what })
  }

  // A path starts below the root: a scene's root is the scene itself, named by its entry.
  const walk = (node: any, where: (path: string) => string, path: string[], root = false): void => {
    if (!node || typeof node !== 'object') return
    const here = node.name && !root ? [...path, String(node.name)] : path
    const f = typeof node.type === 'string' ? NODE_FEATURE.get(node.type) : undefined
    if (f) add(f, where(here.join('/')), `${label(node.type)} node`)
    for (const m of [node.model?.material, ...(Array.isArray(node.model?.materials) ? node.model.materials : [])]) {
      const mf = typeof m?.type === 'string' ? MATERIAL_FEATURE.get(m.type) : undefined
      if (mf) add(mf, where(here.join('/')), `${m.type.replace('_', '-')} material`)
      if (m?.terrainMaterial) { const tf = MATERIAL_FEATURE.get('terrain'); if (tf) add(tf, where(here.join('/')), 'terrain material') }
    }
    if (typeof node.script === 'string')
      for (const { feature, name } of scriptUses(node.script)) add(feature, where(here.join('/')), `its script uses ${name}`)
    for (const child of node.children ?? []) walk(child, where, here)
  }

  // A render setting is a use only for a feature with nothing else to show for it (reflections, ambient
  // occlusion), and only in a 3D scene: these settings are on by default, and a GI or fog setting without a
  // volume to run on does nothing -- counting them would flag every project.
  const settings = (render: any, where: string, dimension?: '2D' | '3D') => {
    if (!render || typeof render !== 'object' || dimension === '2D') return
    for (const f of FEATURES) {
      if (f.nodeTypes?.length) continue
      for (const key of f.renderSettingsOff ?? []) if (render[key]) add(f, where, key)
    }
  }

  for (const entry of Object.values(game.scenes ?? {})) {
    walk(entry.scene, p => p ? `${entry.name} ▸ ${p}` : entry.name, [], true)
    settings(entry.render, `${entry.name} render settings`, entry.dimension ?? (entry.scene?.dimension === '2D' ? '2D' : undefined))
  }
  for (const t of game.templates ?? []) walk(t.node, p => `template ${t.name ?? p}${t.name && p && p !== t.name ? ' ▸ ' + p : ''}`, [])
  for (const [id, source] of Object.entries(game.modules ?? {}))
    for (const { feature, name } of scriptUses(source)) add(feature, `script ${id}`, `uses ${name}`)
  settings(game.config?.render, 'render settings')
  return usage
}

/** The uses of the features a disabled list leaves out (of which a feature's dependents count as its own). */
export function disabledFeatureUses(usage: FeatureUsage, enabled: ReadonlySet<string>): FeatureUsage {
  const out: FeatureUsage = new Map()
  for (const [id, uses] of usage) if (!enabled.has(id) && uses.length) out.set(id, uses)
  return out
}
