import { describe, it, expect } from 'vitest'
import { Node, Scene } from 'cleo'
import { resyncScene } from '../src/utils/sceneResync'
import { instantiateTemplate, TEMPLATE_ID_VAR, type Template } from '../src/utils/templates'
import { isOverridden, readOverrides } from '../src/utils/templateOverrides'
import { buildScriptAsset, SCRIPT_ID_VAR, seedScriptFields, type ScriptAsset } from '../src/utils/scripts'
import { innerAttributeSections, setInstanceAttribute, settableOnInstance } from '../src/utils/instanceAttributes'

// A character template, as the Sandbox's Player: a root (the Collider) holding the Character with its behavior,
// which holds the camera rig with its own. Each script decides, by its fields' accessors, which attributes are
// the CHARACTER's (public: every placement sets its own) and which the BEHAVIOR's (private/protected: set once
// in the template). The instance root's Behaviors panel lists every inner behavior's public attributes, and a
// value set there is that placement's override at the inner node's path.

const PLAYER = `import { Node } from 'cleo'
import { attribute } from 'cleo/decorators'
export default class Player extends Node {
  @attribute('Gait') public walkScale: number = 0.38
  @attribute('Gait') backScale: number = 0.8
  @attribute('Feel') private directionEase: number = 0.1
  @attribute('Feel') protected leanSpeed: number = 4
  public leanLeft: number = 0
  private _lean: number = 0
}`
const CAMERA = `import { Node } from 'cleo'
import { attribute } from 'cleo/decorators'
export default class Camera extends Node {
  @attribute('Framing') public shoulderArm: number = 1.9
  @attribute('Switch') private switchSeconds: number = 0.35
}`
const NOTHING_PUBLIC = `import { Node } from 'cleo'
import { attribute } from 'cleo/decorators'
export default class Prop extends Node {
  @attribute private spin: number = 1
}`
const player = { ...buildScriptAsset('PlayerScript', 'node', PLAYER, 'script-player'), reflect: 2 } as ScriptAsset
const camera = { ...buildScriptAsset('CameraScript', 'node', CAMERA, 'script-camera'), reflect: 2 } as ScriptAsset
const prop = { ...buildScriptAsset('PropScript', 'node', NOTHING_PUBLIC, 'script-prop'), reflect: 2 } as ScriptAsset
const assets = [player, camera, prop]
const assetOf = (n: Node) => assets.find(a => a.id === n.getVariable(SCRIPT_ID_VAR))

const scripted = (asset: ScriptAsset) => ({ [SCRIPT_ID_VAR]: { type: 'string', value: asset.id, access: 'public' } })

/** Collider > Player (script) > [Camera Rig (script), Mannequin, Spinner (a script with nothing public), Sword (a nested instance)]. */
function playerTemplate(shoulderArm = 1.9): Template {
  return {
    id: 'tpl-player', name: 'Player',
    nodeJson: {
      name: 'Player', nodeType: 'node', id: 't-root', children: [{
        name: 'Player', nodeType: 'node', id: 't-char', variables: scripted(player), scriptVars: { walkScale: 0.38, backScale: 0.8, directionEase: 0.1, leanSpeed: 4 },
        children: [
          { name: 'Camera Rig', nodeType: 'node', id: 't-rig', variables: scripted(camera), scriptVars: { shoulderArm, switchSeconds: 0.35 }, children: [] },
          { name: 'Mannequin', nodeType: 'node', id: 't-model', children: [] },
          { name: 'Spinner', nodeType: 'node', id: 't-spin', variables: scripted(prop), scriptVars: { spin: 1 }, children: [] },
          {
            name: 'Sword', nodeType: 'node', id: 't-sword', children: [],
            variables: { ...scripted(camera), [TEMPLATE_ID_VAR]: { type: 'string', value: 'tpl-sword', access: 'public' } },
            scriptVars: { shoulderArm: 1, switchSeconds: 1 },
          },
        ],
      }],
    },
    scripts: {},
  }
}

const libs = (templates: Template[]) =>
  ({ materials: [], models: [], templates, terrainMaterials: [], scripts: assets, tilesets: [], aiBrains: [] }) as any

function place(scene: Scene, template: Template, scripts: Map<string, string>): Node {
  const root = scene.getNodeById(instantiateTemplate(template, scene.root, { scripts }))!
  const visit = (n: Node) => { const a = assetOf(n); if (a) seedScriptFields(n, a, false); (n.children as Node[]).forEach(visit) }
  visit(root)
  return root
}

const field = (asset: ScriptAsset, name: string) => asset.variables.find(v => v.name === name)!

describe('public attributes on a template instance', () => {
  it('a placement may set only shown attributes the script declares public (no modifier counts)', () => {
    const settable = (a: ScriptAsset) => a.variables.filter(settableOnInstance).map(v => v.name)
    expect(settable(player)).toEqual(['walkScale', 'backScale'])
    expect(settable(camera)).toEqual(['shoulderArm'])
    expect(settable(prop)).toEqual([])
  })

  it('lists every inner behavior with public attributes, by path, the root and nested instances left out', () => {
    const scene = new Scene()
    try {
      const root = place(scene, playerTemplate(), new Map())
      const sections = innerAttributeSections(root, assetOf)
      expect(sections.map(s => [s.path, s.asset.name, s.fields.map(f => f.name)])).toEqual([
        ['Player', 'PlayerScript', ['walkScale', 'backScale']],
        ['Player/Camera Rig', 'CameraScript', ['shoulderArm']],
      ])
    } finally { scene.dispose() }
  })

  it('refuses a private or protected attribute, and records a public one at the inner path', () => {
    const scene = new Scene()
    try {
      const root = place(scene, playerTemplate(), new Map())
      const [character, rig] = innerAttributeSections(root, assetOf).map(s => s.node as any)
      expect(setInstanceAttribute(character, field(player, 'directionEase'), 0.5)).toBe(false)
      expect(setInstanceAttribute(character, field(player, 'leanSpeed'), 9)).toBe(false)
      expect(setInstanceAttribute(rig, field(camera, 'switchSeconds'), 2)).toBe(false)
      expect(character.directionEase).toBe(0.1)
      expect(character.leanSpeed).toBe(4)
      expect(rig.switchSeconds).toBe(0.35)
      expect(readOverrides(root)).toEqual({})

      expect(setInstanceAttribute(rig, field(camera, 'shoulderArm'), 2.5)).toBe(true)
      expect(rig.shoulderArm).toBe(2.5)
      expect(isOverridden(rig, 'shoulderArm')).toBe(true)
      expect(readOverrides(root)).toEqual({ 'Player/Camera Rig': { fields: { shoulderArm: 2.5 } } })
    } finally { scene.dispose() }
  })

  it('keeps an inner override through a rebuild from the edited template, the other placement following it', () => {
    const scene = new Scene()
    try {
      const scripts = new Map<string, string>()
      const a = place(scene, playerTemplate(), scripts)
      place(scene, playerTemplate(), scripts)
      const rigOf = (root: Node) => innerAttributeSections(root, assetOf).find(s => s.path === 'Player/Camera Rig')!.node as any
      setInstanceAttribute(rigOf(a), field(camera, 'shoulderArm'), 2.5)

      // The template's rig changes its arm and its switch: one placement keeps its own arm.
      const edited = playerTemplate(1.7)
      edited.nodeJson.children[0].children[0].scriptVars.switchSeconds = 0.5
      expect(resyncScene(scene, { scripts }, libs([edited]), undefined)).toBe(true)

      const instances = Array.from(scene.nodes).filter(n => n.getVariable(TEMPLATE_ID_VAR) === 'tpl-player')
      expect(instances).toHaveLength(2)
      const arms = instances.map(r => rigOf(r).shoulderArm).sort()
      expect(arms).toEqual([1.7, 2.5])
      for (const r of instances) expect(rigOf(r).switchSeconds).toBe(0.5)
    } finally { scene.dispose() }
  })
})
