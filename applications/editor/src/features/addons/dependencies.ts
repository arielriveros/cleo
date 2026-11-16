import { BUILT_IN_ADDONS } from './registry'
import type { AddonManifest } from './types'

// What an addon needs to run (AddonManifest.requires): an addon is active only while it and everything it requires
// are on. Pure, over a project's `addons.enabled` list, so AddonHost, Project ▸ Addons and the new-project dialog
// agree, and tests can check it without an editor.

/**
 * The addons that run with `enabled` on: the known ones whose requirements are all active too (a stored list that
 * holds an addon without what it needs runs neither it nor its slots), requirements first.
 */
export function activeAddons(enabled: readonly string[], addons: readonly AddonManifest[] = BUILT_IN_ADDONS): AddonManifest[] {
  const byId = new Map(addons.map(a => [a.id, a]))
  const on = new Set(enabled)
  const verdict = new Map<string, boolean>()
  const isActive = (id: string, seen: Set<string>): boolean => {
    const known = verdict.get(id)
    if (known !== undefined) return known
    const addon = byId.get(id)
    // Unknown, off, or a requirement loop: not active.
    if (!addon || !on.has(id) || seen.has(id)) return false
    seen.add(id)
    const ok = (addon.requires ?? []).every(r => isActive(r, seen))
    seen.delete(id)
    verdict.set(id, ok)
    return ok
  }
  const out: AddonManifest[] = []
  const placed = new Set<string>()
  const place = (addon: AddonManifest) => {
    if (placed.has(addon.id)) return
    placed.add(addon.id)
    for (const r of addon.requires ?? []) place(byId.get(r)!)
    out.push(addon)
  }
  for (const id of enabled) if (isActive(id, new Set())) place(byId.get(id)!)
  return out
}

/** The addons `id` requires that are not active with `enabled` on (empty when it can run). */
export function missingRequirements(id: string, enabled: readonly string[],
                                    addons: readonly AddonManifest[] = BUILT_IN_ADDONS): AddonManifest[] {
  const active = new Set(activeAddons(enabled, addons).map(a => a.id))
  const addon = addons.find(a => a.id === id)
  return (addon?.requires ?? []).flatMap(r => {
    if (active.has(r)) return []
    const required = addons.find(a => a.id === r)
    return required ? [required] : []
  })
}

/** Every addon that requires `id`, directly or through another. */
export function dependentsOf(id: string, addons: readonly AddonManifest[] = BUILT_IN_ADDONS): AddonManifest[] {
  const out: AddonManifest[] = []
  const visit = (target: string) => {
    for (const a of addons)
      if (a.requires?.includes(target) && !out.includes(a)) { out.push(a); visit(a.id) }
  }
  visit(id)
  return out
}

/** `enabled` with `id` turned off, and every addon that requires it with it. */
export function withoutAddon(enabled: readonly string[], id: string,
                             addons: readonly AddonManifest[] = BUILT_IN_ADDONS): string[] {
  const off = new Set([id, ...dependentsOf(id, addons).map(a => a.id)])
  return enabled.filter(e => !off.has(e))
}

/** `enabled` with `id` turned on (its requirements must already be on: a switch that needs them is greyed). */
export function withAddon(enabled: readonly string[], id: string): string[] {
  return enabled.includes(id) ? [...enabled] : [...enabled, id]
}

/**
 * What to ask before turning `addon` off, when that ends something the user would notice (its own
 * `confirmDisable`, and that of each addon going off with it), or null when there is nothing to ask.
 */
export function addonOffPrompt(addon: AddonManifest, goingWithIt: readonly AddonManifest[]): string | null {
  const parts = [addon.confirmDisable, ...goingWithIt.map(d => `${d.name} needs it and turns off too${d.confirmDisable ? `: ${lowerFirst(d.confirmDisable)}` : '.'}`)]
    .filter((p): p is string => !!p)
  return parts.length ? parts.join(' ') : null
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}
