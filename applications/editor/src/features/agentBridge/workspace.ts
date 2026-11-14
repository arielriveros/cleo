import { SCENE_TAB_ID } from '../engineContextTypes'
import { byName, ready, until, type CommandResult, type GetHost } from './bridgeHost'
import { LIBRARIES, OPENERS } from './libraries'
import { statusData } from './status'

// workspace: the project's scenes and the editor's tabs. Every change is made through the editor's own
// actions (openScene, createScene, enter*Editor, setActiveTab...), so it behaves exactly as the menus do;
// the modals those actions wait on (unsaved changes, a dimension switch that drops work) are answered from
// the call's own `unsaved` choice, never guessed. Each action waits for the editor to settle and answers
// with the editor status, so no status call has to follow.

/** The longest a scene takes to load before the call gives up waiting (the load itself goes on). */
const LOAD_MS = 60_000

function sceneOf(getHost: GetHost, ref: string | undefined) {
  const e = getHost().engine
  if (!ref) {
    const open = e.sceneList.find(s => s.id === e.openSceneId)
    if (!open) throw new Error('No scene is open.')
    return open
  }
  const hit = e.sceneList.find(s => s.id === ref) ?? byName(e.sceneList, ref)
  if (!hit) throw new Error(`No scene "${ref}". Scenes: ${e.sceneList.map(s => `"${s.name}"`).join(', ') || 'none'}.`)
  return hit
}

/** The id of the tab `ref` names: "scene" for the scene tab, otherwise a title (case-insensitive). */
function tabOf(getHost: GetHost, ref: string | undefined): string {
  const e = getHost().engine
  if (!ref) throw new Error('Name the tab: "scene" or a tab title.')
  if (ref.toLowerCase() === 'scene' || ref === SCENE_TAB_ID) return SCENE_TAB_ID
  const hit = e.tabs.find(t => t.title === ref) ?? e.tabs.find(t => t.title.toLowerCase() === ref.toLowerCase())
  if (!hit) throw new Error(`No tab "${ref}". Tabs: ${e.tabs.map(t => `"${t.id === SCENE_TAB_ID ? 'scene' : t.title}"`).join(', ')}.`)
  return hit.id
}

/**
 * Run an editor action that may stop on the Save / Discard / Cancel prompt, and answer it with `unsaved`.
 * Refused up front when there is unsaved work and no choice was given.
 */
async function withUnsaved<T>(getHost: GetHost, dirty: boolean, what: string, unsaved: 'save' | 'discard' | undefined, action: () => Promise<T>): Promise<T> {
  if (dirty && !unsaved) throw new Error(`${what} has unsaved changes: pass unsaved: "save" (keep them) or "discard" (drop them).`)
  const running = action()
  if (dirty) {
    let settled = false
    void running.finally(() => { settled = true })
    await until(() => settled || !!getHost().engine.pendingSceneConfirm, 10_000, 'the unsaved-changes prompt')
    if (!settled) getHost().engine.resolveSceneConfirm(unsaved!)
  }
  return running
}

async function openSceneById(getHost: GetHost, id: string, unsaved: 'save' | 'discard' | undefined, signal?: AbortSignal): Promise<void> {
  const e = getHost().engine
  if (e.isPlayMode) throw new Error('The game is running: play_control {"action":"stop"} first.')
  if (e.openSceneId === id) { e.setActiveTab(SCENE_TAB_ID); return }
  const current = e.sceneList.find(s => s.id === e.openSceneId)
  const ok = await withUnsaved(getHost, !!e.dirtyTabs[SCENE_TAB_ID], `The open scene "${current?.name ?? '?'}"`, unsaved, () => e.openScene(id))
  if (!ok) throw new Error('The scene did not open: another scene was still opening, or the save failed.')
  await until(() => { const x = getHost().engine; return x.openSceneId === id && x.isSceneReady }, LOAD_MS, 'the scene to load', signal)
  // The view rig follows the scene's dimension a render later; the status this call answers with should agree.
  await until(() => { const x = getHost().engine; return x.viewDimension === x.sceneDimension }, 2000, 'the view to follow the scene', signal).catch(() => {})
}

async function afterChange(getHost: GetHost, line: string): Promise<CommandResult> {
  return { text: line, data: await statusData(getHost, { full: false }) }
}

export async function workspace(p: any, getHost: GetHost, signal?: AbortSignal): Promise<CommandResult> {
  ready(getHost)
  const e = getHost().engine
  switch (p.action) {
    case 'listScenes':
      return {
        text: e.sceneList.map(s => `${s.name} (#${s.id})${s.id === e.mainSceneId ? ' main' : ''}${s.id === e.openSceneId ? ` open${e.dirtyTabs[SCENE_TAB_ID] ? ', unsaved' : ''}` : ''}`).join('\n') || 'The project has no scenes.',
      }
    case 'openScene': {
      if (!p.scene) throw new Error('openScene needs scene (a name or an id).')
      const target = sceneOf(getHost, p.scene)
      await openSceneById(getHost, target.id, p.unsaved, signal)
      return afterChange(getHost, `Opened scene "${target.name}" (its undo history starts fresh).`)
    }
    case 'newScene': {
      const id = await e.createScene(p.name?.trim() || undefined)
      await until(() => getHost().engine.sceneList.some(s => s.id === id), 5000, 'the new scene to be listed', signal)
      const made = getHost().engine.sceneList.find(s => s.id === id)!
      if (p.open === false) return afterChange(getHost, `Created scene "${made.name}" (#${id}); not opened.`)
      await openSceneById(getHost, id, p.unsaved, signal)
      return afterChange(getHost, `Created and opened scene "${made.name}" (#${id}).`)
    }
    case 'renameScene': {
      const target = sceneOf(getHost, p.scene)
      if (!p.name?.trim()) throw new Error('renameScene needs name.')
      e.renameScene(target.id, p.name.trim())
      await until(() => getHost().engine.sceneList.find(s => s.id === target.id)?.name !== target.name, 5000, 'the rename', signal)
      return afterChange(getHost, `Renamed scene "${target.name}" to "${getHost().engine.sceneList.find(s => s.id === target.id)?.name}".`)
    }
    case 'setMainScene': {
      const target = sceneOf(getHost, p.scene)
      e.setMainScene(target.id)
      await until(() => getHost().engine.mainSceneId === target.id, 5000, 'the main scene to change', signal)
      return afterChange(getHost, `"${target.name}" is the main scene: Play from the project and published games start there.`)
    }
    case 'duplicateScene': {
      const target = sceneOf(getHost, p.scene)
      const id = await e.duplicateScene(target.id)
      if (!id) throw new Error(`"${target.name}" could not be duplicated.`)
      await until(() => getHost().engine.sceneList.some(s => s.id === id), 5000, 'the copy to be listed', signal)
      return afterChange(getHost, `Duplicated "${target.name}" as "${getHost().engine.sceneList.find(s => s.id === id)?.name}" (#${id}); not opened.`)
    }
    case 'setDimension': {
      const dim = p.dimension
      if (dim !== '2D' && dim !== '3D') throw new Error('setDimension needs dimension: "2D" or "3D".')
      if (e.sceneDimension === dim) return afterChange(getHost, `The scene is ${dim} already.`)
      const running = e.setSceneDimension(e.openSceneId, dim)
      let settled = false
      void running.finally(() => { settled = true })
      await until(() => settled || !!getHost().engine.pendingDimensionConfirm, 10_000, 'the dimension switch', signal)
      const pending = getHost().engine.pendingDimensionConfirm
      if (!settled && pending) {
        // The switch drops the other dimension's work: only with the agent's explicit say-so.
        const go = p.unsaved === 'discard'
        getHost().engine.resolveDimensionConfirm(go)
        await running
        if (!go) throw new Error(`Switching to ${dim} drops the scene's ${pending.count} ${pending.losing}${pending.count === 1 ? '' : 's'}: pass unsaved: "discard" to go ahead.`)
      } else await running
      await until(() => getHost().engine.sceneDimension === dim, 5000, 'the dimension to change', signal)
      return afterChange(getHost, `The scene is ${dim} now.`)
    }
    case 'openAsset': {
      const kind = p.kind
      if (!kind || !LIBRARIES[kind]) throw new Error(`openAsset needs kind: ${Object.keys(LIBRARIES).join(', ')}.`)
      if (!p.name) throw new Error('openAsset needs name.')
      if (e.isPlayMode) throw new Error('The game is running: play_control {"action":"stop"} first.')
      const items = LIBRARIES[kind](e)
      const asset = byName(items, p.name)
      if (!asset) throw new Error(`No ${kind} named "${p.name}". ${items.length ? `Available: ${items.slice(0, 30).map(i => `"${i.name}"`).join(', ')}.` : 'The project has none.'}`)
      const before = e.activeTabId
      OPENERS[kind](e, asset.id)
      await until(() => { const x = getHost().engine; return (x.activeTabId !== before || x.activeTab?.title === asset.name) && x.isSceneReady }, 20_000, `the ${kind} tab to open`, signal)
      return afterChange(getHost, `Opened ${kind} "${asset.name}" in its tab${kind === 'template' || kind === 'model' ? ': scene_edit now edits its nodes, scene_save saves it (and updates its placed copies)' : ''}.`)
    }
    case 'switchTab': {
      const id = tabOf(getHost, p.tab)
      e.setActiveTab(id)
      await until(() => { const x = getHost().engine; return x.activeTabId === id && x.isSceneReady }, 20_000, 'the tab to show', signal)
      return afterChange(getHost, `Switched to ${id === SCENE_TAB_ID ? 'the scene tab' : `"${getHost().engine.activeTab?.title}"`}.`)
    }
    case 'closeTab': {
      const id = tabOf(getHost, p.tab)
      if (id === SCENE_TAB_ID) throw new Error('The scene tab cannot be closed (open another scene instead).')
      const tab = e.tabs.find(t => t.id === id)!
      await withUnsaved(getHost, !!e.dirtyTabs[id], `The tab "${tab.title}"`, p.unsaved, async () => { await e.closeTab(id) })
      await until(() => !getHost().engine.tabs.some(t => t.id === id), 10_000, 'the tab to close', signal)
      return afterChange(getHost, `Closed "${tab.title}".`)
    }
    default:
      throw new Error(`Unknown action ${JSON.stringify(p.action)}.`)
  }
}
