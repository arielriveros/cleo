import type { Node } from 'cleo'

// What the Animator editor's Event Actions panel offers a target field: the nodes an action could name, as the paths
// the engine resolves (animation/eventActions.ts `resolveTarget`: found below the animated node, then below each
// ancestor). A target is typed by what the action does to it: a sound plays, a particle system bursts, a light flashes.

export type TargetKind = 'sound' | 'particleSystem' | 'light' | 'any'

const isHelper = (name: string) => name.startsWith('__debug__') || name.startsWith('__editor__')

/** Every node of `kind` the engine would find for `owner`: below it, then below each ancestor. Nearest first, no repeats. */
function candidates(owner: Node, kind: TargetKind, limit: number): Node[] {
  const out: Node[] = []
  const seen = new Set<Node>()
  const walk = (from: Node) => {
    const queue: Node[] = [from]
    for (let head = 0; head < queue.length && out.length < limit; head++) {
      for (const child of queue[head].children) {
        if (isHelper(child.name) || seen.has(child)) continue
        seen.add(child)
        if (kind === 'any' || child.nodeType === kind) out.push(child)
        queue.push(child)
      }
    }
  }
  for (let at: Node | null = owner; at && out.length < limit; at = at.parent) walk(at)
  return out
}

/**
 * The paths a target field offers, nearest first. A name alone is enough for the engine (it looks for it below the
 * character, then below each parent), so a path carries its parent group (`Sounds/Shot`) only when the bare name would
 * be ambiguous between two nodes.
 */
export function targetPaths(owner: Node | null | undefined, kind: TargetKind, limit = 200): string[] {
  if (!owner) return []
  const nodes = candidates(owner, kind, limit)
  const counts = new Map<string, number>()
  for (const n of nodes) counts.set(n.name, (counts.get(n.name) ?? 0) + 1)
  const out: string[] = []
  const seen = new Set<string>()
  for (const n of nodes) {
    const parent = n.parent
    const path = (counts.get(n.name) ?? 0) > 1 && parent && parent.parent && !isHelper(parent.name) ? `${parent.name}/${n.name}` : n.name
    if (!seen.has(path)) { seen.add(path); out.push(path) }
  }
  return out
}

/** The event names the clips an animator plays carry, plus the machine's own markers and any already bound. */
export function eventNamesOf(
  clips: readonly { name: string; events?: readonly { name: string }[] }[],
  machineEvents: readonly { eventName: string }[] | undefined,
  bound: readonly { event: string }[] | undefined,
): string[] {
  const names = new Set<string>()
  for (const c of clips) for (const e of c.events ?? []) if (e.name) names.add(e.name)
  for (const e of machineEvents ?? []) if (e.eventName) names.add(e.eventName)
  for (const b of bound ?? []) if (b.event) names.add(b.event)
  return [...names].sort()
}
