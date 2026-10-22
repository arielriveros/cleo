// The Character Animation workspace: every animation editor for one SKELETON shown as one document.
//
// A skeleton's skeleton editor, its clips, its animators and its blend spaces are separate editing
// sessions underneath (each keeps its own working copy and preview), but to the user they are one thing —
// "Hero's animation" — so the tab strip shows one tab per skeleton and the workspace bar switches between
// the parts. This module decides which skeleton a tab belongs to and groups the strip accordingly.
//
// Engine-free so it is unit-testable.

/** The tab fields this module reads, restated structurally. */
export type WorkspaceTab = {
  id: string
  kind: string
  title: string
  rigId?: string | null
  animationId?: string | null
  animationFieldId?: string | null
  workspaceRigId?: string | null
}

export type WorkspaceLibs = {
  rigs: { id: string; name: string; animationIds?: string[] }[]
  animations: { id: string; rigId?: string }[]
  animationFields: { id: string; rigId?: string }[]
}

/** The tab kinds that are parts of a Character Animation workspace. */
export const WORKSPACE_KINDS = ['rig', 'animation', 'stateMachine', 'animationField'] as const
export type WorkspacePart = 'skeleton' | 'clips' | 'animator' | 'blendSpace'

export const PART_OF_KIND: Record<(typeof WORKSPACE_KINDS)[number], WorkspacePart> = {
  rig: 'skeleton',
  animation: 'clips',
  stateMachine: 'animator',
  animationField: 'blendSpace',
}

export const PART_LABEL: Record<WorkspacePart, string> = {
  skeleton: 'Skeleton',
  clips: 'Clips',
  animator: 'Animator',
  blendSpace: 'Blend Spaces',
}

export function isWorkspaceKind(kind: string): kind is (typeof WORKSPACE_KINDS)[number] {
  return (WORKSPACE_KINDS as readonly string[]).includes(kind)
}

/**
 * The skeleton a tab's workspace is keyed on, or null when it has none (it then stands alone).
 *
 * A clip asset is OWNED by the skeletons that link it, which need not be the one its keys were authored
 * against (a Mixamo clip linked to a custom character). The linking skeleton wins, preferring one whose
 * workspace is already open (`openRigIds`), so editing a clip from Hero's workspace stays in it.
 */
export function workspaceRigIdOf(tab: WorkspaceTab, libs: WorkspaceLibs, openRigIds: ReadonlySet<string> = new Set()): string | null {
  switch (tab.kind) {
    case 'rig':
      return tab.rigId ?? null
    case 'stateMachine':
      return tab.workspaceRigId ?? null
    case 'animationField':
      return libs.animationFields.find(f => f.id === tab.animationFieldId)?.rigId ?? null
    case 'animation': {
      if (!tab.animationId) return null
      const owners = libs.rigs.filter(r => r.animationIds?.includes(tab.animationId!))
      const open = owners.find(r => openRigIds.has(r.id))
      if (open) return open.id
      if (owners.length) return owners[0].id
      return libs.animations.find(a => a.id === tab.animationId)?.rigId ?? null
    }
    default:
      return null
  }
}

/** One entry of the grouped tab strip: a plain tab, or a skeleton's workspace standing for its parts. */
export type StripEntry =
  | { type: 'tab'; tabId: string }
  | { type: 'workspace'; rigId: string; title: string; memberIds: string[] }

/**
 * The tab strip with every workspace's parts collapsed onto one entry, placed where its FIRST part sits
 * so opening a second part never makes the strip jump.
 */
export function groupTabStrip(tabs: WorkspaceTab[], libs: WorkspaceLibs): StripEntry[] {
  const directRigs = new Set<string>()
  for (const t of tabs) {
    if (t.kind === 'rig' && t.rigId) directRigs.add(t.rigId)
    if (t.kind === 'stateMachine' && t.workspaceRigId) directRigs.add(t.workspaceRigId)
  }
  const out: StripEntry[] = []
  const byRig = new Map<string, Extract<StripEntry, { type: 'workspace' }>>()
  for (const t of tabs) {
    const rigId = isWorkspaceKind(t.kind) ? workspaceRigIdOf(t, libs, directRigs) : null
    if (!rigId) { out.push({ type: 'tab', tabId: t.id }); continue }
    let entry = byRig.get(rigId)
    if (!entry) {
      const name = libs.rigs.find(r => r.id === rigId)?.name
      entry = { type: 'workspace', rigId, title: name ?? t.title, memberIds: [] }
      byRig.set(rigId, entry)
      out.push(entry)
    }
    entry.memberIds.push(t.id)
  }
  return out
}

/** The open tabs that make up `rigId`'s workspace, in strip order. */
export function workspaceMembers(tabs: WorkspaceTab[], libs: WorkspaceLibs, rigId: string): WorkspaceTab[] {
  const entry = groupTabStrip(tabs, libs).find(e => e.type === 'workspace' && e.rigId === rigId)
  if (!entry || entry.type !== 'workspace') return []
  return entry.memberIds.map(id => tabs.find(t => t.id === id)!).filter(Boolean)
}
