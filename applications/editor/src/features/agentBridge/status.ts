import { APP_VERSION } from '../../version'
import { readPlayTarget } from '../playWindow/playTarget'
import { isWindowPlayActive, windowPlay } from '../playWindow/windowPlay'
import { agentBridge } from './bridgeClient'
import { readScene, type GetHost } from './bridgeHost'
import { nodePath, walkUserNodes } from './nodeRefs'
import { describePanes } from './shots'

// editor_status, and the summary workspace answers with after a scene or tab change: what is open, what
// is running, what is selected.

export async function projectInfo(): Promise<{ id: string | null; name: string | null }> {
  try {
    const { activeProjectId } = await import('../../utils/projectScope')
    const { loadProjects } = await import('../../utils/projects')
    const id = activeProjectId() || null
    const name = id ? (await loadProjects()).find(p => p.id === id)?.name ?? null : null
    return { id, name }
  } catch { return { id: null, name: null } }
}

export async function statusData(getHost: GetHost, opts: { full?: boolean } = {}): Promise<Record<string, unknown>> {
  const h = getHost()
  const e = h.engine
  const scene = e.instance ? readScene(h) : null
  let nodes = 0
  if (scene) walkUserNodes(scene.root, () => { nodes++ })
  const selected = e.selectedNode && scene ? scene.getNodeById(e.selectedNode) : null
  let backend = 'default'
  try { backend = localStorage.getItem('cleo_renderer_backend') ?? 'default' } catch { /* ignore */ }
  const win = isWindowPlayActive() ? windowPlay().getSnapshot() : null
  const panes = describePanes()
  return {
    ...(opts.full !== false ? {
      editor: { version: APP_VERSION, origin: location.origin, renderer: backend, loading: !e.isSceneReady },
      project: await projectInfo(),
    } : {}),
    scenes: e.sceneList.map(s => ({ name: s.name, id: s.id, main: s.id === e.mainSceneId, open: s.id === e.openSceneId })),
    dimension: { scene: e.sceneDimension, view: e.viewDimension },
    activeTab: { title: e.activeTab?.title, kind: e.activeTab?.kind, unsaved: !!e.dirtyTabs[e.activeTabId] },
    tabs: e.tabs.map(t => `${t.title} [${t.kind}]${e.dirtyTabs[t.id] ? ' *' : ''}`),
    editorMode: e.editorMode,
    play: e.isPlayMode
      ? { state: e.isSimulating ? 'simulate' : 'play', paused: !!e.instance?.isPaused }
      : { state: 'editing', ...(win ? { window: { status: win.status, scene: win.scene ?? null } } : {}) },
    playTarget: readPlayTarget(),
    viewport: panes.text,
    selected: selected ? nodePath(selected, scene!.root) : null,
    sceneNodes: nodes,
    ...(opts.full !== false ? { agent: { executeAllowed: agentBridge.executeAllowed } } : {}),
  }
}
