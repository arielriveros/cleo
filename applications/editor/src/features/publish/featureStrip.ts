// What leaving features out of a game does to its data, at publish (see src/modules/catalog.ts): the nodes only
// a left-out feature has are stripped from every scene and template, and the render settings that would run it
// are turned off. Runs where the dimension strip does, before textures and sounds are collected, so stripped
// nodes take their assets with them. Pure, over serialized JSON.
import { FEATURES, enabledFeatures } from 'cleo'

/** What a set of left-out features strips. */
export interface FeatureStripRules {
  /** The features left on, their dependencies resolved. */
  readonly enabled: ReadonlySet<string>;
  /** Node types to strip, and how. */
  readonly nodes: ReadonlyMap<string, 'subtree' | 'node'>;
  /** Render settings to turn off. */
  readonly renderSettingsOff: readonly string[];
  /** Shader modules the game's library leaves out. */
  readonly shaderModules: ReadonlySet<string>;
}

/** The rules for a project's disabled list. */
export function featureStripRules(disabled: readonly string[]): FeatureStripRules {
  const enabled = enabledFeatures(disabled)
  const nodes = new Map<string, 'subtree' | 'node'>()
  const renderSettingsOff: string[] = []
  const shaderModules = new Set<string>()
  for (const f of FEATURES) {
    if (enabled.has(f.id)) continue
    for (const t of f.nodeTypes ?? []) nodes.set(t, f.strip ?? 'subtree')
    renderSettingsOff.push(...(f.renderSettingsOff ?? []))
    for (const m of f.shaderModules ?? []) shaderModules.add(m)
  }
  return { enabled, nodes, renderSettingsOff, shaderModules }
}

/**
 * A stripped node that keeps its children: a plain node in its place, its name, transform and children as
 * they were, its feature's payload gone. A 2D body carries the sprite it moves; the sprite stays where it was.
 */
function asPlainNode(node: any): any {
  const plain = { ...node, type: 'node' }
  if (typeof node.type === 'string') delete plain[node.type]
  return plain
}

/** Strip a serialized scene tree, in place. Returns how many nodes went. The root is never stripped. */
export function stripFeatureNodes(sceneJson: any, rules: FeatureStripRules): number {
  if (!rules.nodes.size) return 0
  let removed = 0
  const walk = (node: any): void => {
    if (!node || !Array.isArray(node.children)) return
    let changed = false
    const kept: any[] = []
    for (const child of node.children) {
      const how = typeof child?.type === 'string' ? rules.nodes.get(child.type) : undefined
      if (how === 'subtree') { removed++; changed = true; continue }
      const next = how === 'node' ? asPlainNode(child) : child
      if (next !== child) { removed++; changed = true }
      walk(next)
      kept.push(next)
    }
    if (changed) node.children = kept
  }
  walk(sceneJson)
  return removed
}

/** Turn off, in place, the render settings a left-out feature would run. */
export function stripFeatureSettings(render: any, rules: FeatureStripRules): void {
  if (!render || typeof render !== 'object') return
  for (const key of rules.renderSettingsOff) if (render[key]) render[key] = false
}
