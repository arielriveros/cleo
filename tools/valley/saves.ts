// Saving in the shipped Dungeon (SaveGame, src/core/save): the souls scripts' current sources (their `@save`
// fields, the bonfire saves, Continue), the title menu, the pause menu's Load Last Rest, and a Saved bloodstain.
// The generator (tools/soulsDemo/build.mjs, mirrored there) cannot run without its art, so this edits the
// SHIPPED bundle, and is re-runnable: everything it adds has a stable id and replaces what an earlier run added.

import fs from 'fs'
import path from 'path'
import { id, nodes, scriptIdOf, attach, child, log, scriptAsset } from './bundleOps'
import { syncScripts } from '../exampleKit/syncScripts.mjs'

const defaultClass = (source: string) => /export\s+default\s+(?:abstract\s+)?class\s+(\w+)/.exec(source ?? '')?.[1]

/** Every serialized tree in the bundle: each scene's root and each template's. */
const roots = (bundle: any): any[] =>
  [...Object.values(bundle.scenes).map((s: any) => s.scene), ...bundle.libraries.templates.map((t: any) => t.nodeJson)]

/**
 * Put each souls class script's source on disk into the library, and into every node and template that embeds
 * it (keeping the field values the script still declares). Modules (no default class) are left as they are.
 */
export function refreshSoulsScripts(bundle: any): string[] {
  // The scripts ARE the example folder's .ts files: what can be stale is their reflected fields.
  const changed = new Set(syncScripts(bundle))
  const refreshed = new Map<string, any>((bundle.libraries.scripts ?? []).filter((s: any) => changed.has(s.name)).map((s: any) => [s.id, s]))
  for (const root of roots(bundle)) for (const n of nodes(root)) {
    const asset = refreshed.get(scriptIdOf(n))
    if (asset) attach(n, asset)
  }
  return [...changed]
}

const TITLE_FOLDER = '/Game/UI/Scripts'

/** The title menu's script asset (SoulsTitleMenu.ts), added once and refreshed after. */
function titleScript(bundle: any): any {
  const lib = bundle.libraries.scripts
  const fresh = scriptAsset('SoulsTitleMenu', 'Title Menu', 'uiRoot', bundle)
  const at = lib.findIndex((s: any) => s.id === fresh.id)
  if (at >= 0) { lib[at] = { ...lib[at], source: fresh.source, variables: fresh.variables }; return lib[at] }
  lib.push(fresh)
  const entryPath = `${TITLE_FOLDER}/${fresh.name}.script`
  if (!bundle.vfs.entries.some((e: any) => e.path === entryPath))
    bundle.vfs.entries.push({ path: entryPath, kind: 'script', assetId: fresh.id, created: bundle.manifest.createdAt })
  for (let d = TITLE_FOLDER; d && d !== '/'; d = path.posix.dirname(d))
    if (!bundle.vfs.folders.includes(d)) bundle.vfs.folders.push(d)
  for (const meta of bundle.manifest.sceneMetas ?? []) {
    const refs = (meta.refs ??= {})
    refs.scriptIds = [...new Set([...(refs.scriptIds ?? []), fresh.id])]
  }
  return fresh
}

/** Give every node of a cloned subtree a stable id of its own, from its name path under `key`. */
function restamp(json: any, key: string): void {
  json.id = id(key)
  const seen = new Map<string, number>()
  for (const c of json.children ?? []) {
    const k = seen.get(c.name) ?? 0
    seen.set(c.name, k + 1)
    restamp(c, `${key}/${c.name}#${k}`)
  }
}

const withChildren = (n: any, keep: (c: any) => boolean) => { n.children = (n.children ?? []).filter(keep) }

/** The pause menu's Load Last Rest button (SoulsPauseMenu), under Return to Bonfire, on a card made taller for it. */
function pauseLoadButton(pause: any, key: string): void {
  const card = child(child(pause, 'Backdrop'), 'Card')
  const bonfire = child(card, 'Bonfire')
  if (!card || !bonfire) throw new Error('Dungeon: the pause menu has no Card / Bonfire button to add Load Last Rest under')
  card.ui.offsetMin = [-300, -230]
  card.ui.offsetMax = [300, 230]
  withChildren(card, c => c.name !== 'Load')
  const load = structuredClone(bonfire)
  load.id = id(`saves:${key}:pause:load`)
  load.name = 'Load'
  load.ui.label = 'Load Last Rest'
  load.ui.offsetMin = [-180, 256]
  load.ui.offsetMax = [180, 308]
  card.children.splice(card.children.indexOf(bonfire) + 1, 0, load)
}

/** The title menu (SoulsTitleMenu): the pause menu's look, with Continue and New Game. */
function titleMenu(pause: any, asset: any, key: string): any {
  const title = structuredClone(pause)
  title.name = 'TitleMenu'
  restamp(title, `saves:${key}:title`)
  title.visible = false
  title.ui.zOrder = (pause.ui?.zOrder ?? 60) + 10
  attach(title, asset, {})
  const backdrop = child(title, 'Backdrop')
  backdrop.ui.tint = [0, 0, 0, 0.7]
  const card = child(backdrop, 'Card')
  card.ui.offsetMin = [-300, -190]
  card.ui.offsetMax = [300, 190]
  withChildren(card, c => c.name !== 'Load')
  child(card, 'Title').ui.text = 'HOLLOW KEEP'
  const resume = child(card, 'Resume')
  resume.name = 'Continue'
  resume.ui.label = 'Continue'
  const bonfire = child(card, 'Bonfire')
  bonfire.name = 'New Game'
  bonfire.ui.label = 'New Game'
  child(card, 'Hint').ui.text = 'Up / Down choose · Enter or A confirm · the game saves at every bonfire'
  return title
}

/** Everything saving needs in the Dungeon. Returns what it did, for the log. */
export function applySaves(bundle: any): void {
  const refreshed = refreshSoulsScripts(bundle)
  log(`saves: refreshed ${refreshed.length} souls scripts (${refreshed.join(', ')})`)
  const asset = titleScript(bundle)

  // The Player template AND its placed copy in the scene, alike: a copy holds exactly its template's nodes, so
  // an editor rebuild from the template keeps the menus. Each gets ids of its own (keyed by its tree).
  const trees: [string, any][] = [
    ...Object.entries(bundle.scenes).map(([sceneId, s]: [string, any]) => [`scene:${sceneId}`, s.scene] as [string, any]),
    ...bundle.libraries.templates.map((t: any) => [`template:${t.id}`, t.nodeJson] as [string, any]),
  ]
  for (const [key, root] of trees) {
    const player = [...nodes(root)].find((n: any) => n.name === 'Player' && n.type === 'character')
    const pause = child(player, 'PauseMenu')
    if (!player || !pause) continue
    pauseLoadButton(pause, key)
    // The menus are the Player's; its controller stays its LAST child (the character needs it there).
    withChildren(player, c => c.name !== 'TitleMenu')
    const controller = player.children.findIndex((c: any) => c.type === 'controller')
    player.children.splice(controller >= 0 ? controller : player.children.length, 0, titleMenu(pause, asset, key))
    log(`saves: ${key}: the pause menu has Load Last Rest, the Player has the title menu`)
  }

  // A death's bloodstain is a Saved copy: a save made after it keeps it where it lies, with its souls.
  const stain = bundle.libraries.templates.find((t: any) => t.name === 'Bloodstain')
  if (!stain) throw new Error('Dungeon: no Bloodstain template')
  stain.nodeJson.saved = true
  log('saves: the Bloodstain template is Saved')
}
