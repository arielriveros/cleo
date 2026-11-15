// What a game uses of the engine's optional features (src/modules/catalog.ts), read from its serialized scenes,
// templates and scripts: the Features panel's "Detect from project" and the check Publish runs when a project
// has features turned off. Static, like Godot's detection: a node a script builds from a string, or a feature
// reached through another, is not seen. Pure, over serialized JSON.
import { FEATURES, featureApiNames, type FeatureDef } from 'cleo'

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
const FEATURE_BY_ID = new Map<string, FeatureDef>()
for (const f of FEATURES) {
  FEATURE_BY_ID.set(f.id, f)
  for (const t of f.nodeTypes ?? []) NODE_FEATURE.set(t, f)
  for (const m of f.materialTypes ?? []) MATERIAL_FEATURE.set(m, f)
}

/**
 * What a node uses that its type alone does not say: a trigger in a 2D scene is a 2D area (the 2D physics
 * steps it), an AI-driven controller thinks with the AI feature, and a model with cloth parts simulates them
 * with the Cloth feature.
 */
function nodeUses(node: any, dimension: '2D' | '3D' | undefined): [string, string][] {
  const out: [string, string][] = []
  if (node.type === 'trigger' && dimension === '2D') out.push(['physics2d', 'Trigger node in a 2D scene'])
  if (node.type === 'controller' && node.controlSource === 'ai') out.push(['ai', 'AI-driven controller'])
  if (node.model?.skinnedCloth) out.push(['cloth', 'cloth parts on its model'])
  return out
}

/**
 * The script names of a feature: every name its module adds to the engine API (src/modules/<id>/api.ts), and the
 * catalog's list (which also holds core names that are a feature's only sign of use, such as `InputSystem`).
 */
function namesOf(f: FeatureDef): readonly string[] {
  return [...new Set([...featureApiNames(f.id), ...(f.apiNames ?? [])])]
}

/**
 * Features a script reaches through the scene rather than by name, so whether or not it imports the engine:
 * `this.scene.physics2D` is the 2D physics world.
 */
const MEMBER_USES: readonly { feature: string; test: RegExp; name: string }[] = [
  { feature: 'physics2d', test: /\.physics2D\b/, name: 'scene.physics2D' },
]

const label = (type: string) => type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase())

/** Whether `source` imports the engine at all: only then can a feature's name in it be the feature's. */
const importsCleo = (source: string) => /\bfrom\s*['"]cleo['"]|import\s*\(\s*['"]cleo['"]\s*\)|__cleoImport\(\s*['"]cleo['"]/.test(source)

/** The feature names a script uses, by whole word, when it imports the engine. */
function scriptUses(source: string): { feature: FeatureDef; name: string }[] {
  if (typeof source !== 'string') return []
  const out: { feature: FeatureDef; name: string }[] = []
  for (const use of MEMBER_USES) {
    const feature = FEATURE_BY_ID.get(use.feature)
    if (feature && use.test.test(source)) out.push({ feature, name: use.name })
  }
  if (!importsCleo(source)) return out
  for (const f of FEATURES) for (const name of namesOf(f))
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
  const walk = (node: any, where: (path: string) => string, path: string[], dimension: '2D' | '3D' | undefined,
                root = false): void => {
    if (!node || typeof node !== 'object') return
    const here = node.name && !root ? [...path, String(node.name)] : path
    const f = typeof node.type === 'string' ? NODE_FEATURE.get(node.type) : undefined
    if (f) add(f, where(here.join('/')), `${label(node.type)} node`)
    for (const [id, what] of nodeUses(node, dimension)) {
      const used = FEATURE_BY_ID.get(id)
      if (used) add(used, where(here.join('/')), what)
    }
    for (const m of [node.model?.material, ...(Array.isArray(node.model?.materials) ? node.model.materials : [])]) {
      const mf = typeof m?.type === 'string' ? MATERIAL_FEATURE.get(m.type) : undefined
      if (mf) add(mf, where(here.join('/')), `${m.type.replace('_', '-')} material`)
      if (m?.terrainMaterial) { const tf = MATERIAL_FEATURE.get('terrain'); if (tf) add(tf, where(here.join('/')), 'terrain material') }
    }
    if (typeof node.script === 'string')
      for (const { feature, name } of scriptUses(node.script)) add(feature, where(here.join('/')), `its script uses ${name}`)
    for (const child of node.children ?? []) walk(child, where, here, dimension)
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
    const dimension = entry.dimension ?? (entry.scene?.dimension === '2D' ? '2D' : undefined)
    walk(entry.scene, p => p ? `${entry.name} ▸ ${p}` : entry.name, [], dimension, true)
    settings(entry.render, `${entry.name} render settings`, dimension)
  }
  // A template can land in a scene of either dimension: its triggers are not counted as 2D areas.
  for (const t of game.templates ?? []) walk(t.node, p => `template ${t.name ?? p}${t.name && p && p !== t.name ? ' ▸ ' + p : ''}`, [], undefined)
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
