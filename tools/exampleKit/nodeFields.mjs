// The node fields of the example scripts (`sun: LightNode`, `tour: SequenceNode`), as the shipped scenes store
// them: `{ $nodePath: '../Sun' }`, the path from the script's node to the node it names (the engine's
// relativeNodePath, src/core/save/nodePaths.ts, on serialized JSON). Each field is pointed at the node of the
// name it used to look up at runtime, so the example plays as it did.
//
// Re-runnable: a field that already holds a path leading to a node is left alone. Run by reflectScripts.ts
// over every shipped bundle, and by the Sandbox's generator (tools/sandbox/build.ts), which rebuilds its scene.

/** Script class -> field -> the name of the node it points at. */
export const NODE_FIELDS = {
  SandboxGameManagerNode: { sun: 'Sun', hudLine: 'Light Setup', probe: 'Light Probe' },
  SoulsGameManagerNode: { bossReward: 'Boss Reward', bossEpilogue: 'Epilogue Message' },
  ValleyStartMenuNode: { tour: 'Valley Tour', day: 'Day Cycle' },
  ValleyTourDirectorNode: { flash: 'Lightning' },
}

const DEFAULT_CLASS = /export\s+default\s+(?:abstract\s+)?class\s+(\w+)/

/** `name`, or `name#k` for the k-th later sibling of the same name (the engine's segment rule). */
function segment(parent, node) {
  let k = 0
  for (const sibling of parent.children ?? []) {
    if (sibling === node) break
    if (sibling?.name === node.name) k++
  }
  return k === 0 ? String(node.name ?? '') : `${node.name}#${k}`
}

/** The path from `from` to `to` in the serialized tree under `root`, or null when either is not in it. */
export function jsonNodePath(root, from, to) {
  const parent = new Map()
  const walk = n => { for (const c of n?.children ?? []) { parent.set(c, n); walk(c) } }
  walk(root)
  if (from === to) return '.'
  const ups = new Map()
  let steps = 0
  for (let n = from; n; n = parent.get(n)) ups.set(n, steps++)
  for (let n = to, down = []; n; n = parent.get(n)) {
    if (ups.has(n)) {
      const parts = new Array(ups.get(n)).fill('..').concat(down)
      return parts.join('/') || '.'
    }
    const p = parent.get(n)
    if (!p) return null
    down.unshift(segment(p, n))
  }
  return null
}

/** The node `path` leads to from `from` (jsonNodePath's form), or null. */
export function jsonNodeAtPath(root, from, path) {
  const parent = new Map()
  const walk = n => { for (const c of n?.children ?? []) { parent.set(c, n); walk(c) } }
  walk(root)
  let n = from
  for (const part of path.split('/')) {
    if (!n) return null
    if (part === '' || part === '.') continue
    if (part === '..') { n = parent.get(n) ?? null; continue }
    const hash = part.lastIndexOf('#')
    const [name, index] = hash > 0 && /^\d+$/.test(part.slice(hash + 1)) ? [part.slice(0, hash), Number(part.slice(hash + 1))] : [part, 0]
    let k = 0
    n = (n.children ?? []).find(c => c?.name === name && k++ === index) ?? null
  }
  return n
}

/** The first node named `name` under `root`, breadth first, as `findNode` finds it. */
function byName(root, name) {
  const queue = [root]
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i]
    if (n !== root && n?.name === name) return n
    for (const c of n?.children ?? []) queue.push(c)
  }
  return null
}

/**
 * Point every node field of `NODE_FIELDS` in the serialized scene `root` at its node. `scripts` is the bundle's
 * script library (a node's `__scriptId` names one). Returns how many fields were set; `log` hears the misses.
 */
export function applyNodeFields(root, scripts, log = () => {}) {
  const classOf = new Map((scripts ?? []).map(s => [s.id, DEFAULT_CLASS.exec(s.source ?? '')?.[1]]))
  let set = 0
  const visit = n => {
    const fields = NODE_FIELDS[classOf.get(n?.variables?.__scriptId?.value)]
    if (fields) {
      for (const [field, name] of Object.entries(fields)) {
        const current = n.scriptVars?.[field]
        if (current?.$nodePath && jsonNodeAtPath(root, n, current.$nodePath)) continue
        const target = byName(root, name)
        const path = target && jsonNodePath(root, n, target)
        if (!path) { log(`  ${n.name}.${field}: no '${name}' in the scene`); continue }
        n.scriptVars = { ...(n.scriptVars ?? {}), [field]: { $nodePath: path } }
        set++
      }
    }
    for (const c of n?.children ?? []) visit(c)
  }
  visit(root)
  return set
}
