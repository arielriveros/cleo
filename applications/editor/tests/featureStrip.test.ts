import { describe, it, expect } from 'vitest';
import { featureStripRules, stripFeatureNodes, stripFeatureSettings } from '../src/features/publish/featureStrip';
import { featureUsage, disabledFeatureUses } from '../src/features/publish/featureUsage';

// What leaving features out (Project ▸ Features) does to a game's data at publish, and how the check before it
// finds what a game uses. The catalog itself is the engine's src/modules/catalog.ts.

const node = (type: string, name: string, extra: any = {}) => ({ type, name, id: name, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], ...extra });

describe('stripping the features a game leaves out', () => {
  it('turns a disabled list into what it strips, dependencies included', () => {
    const rules = featureStripRules(['particles', 'landscape'])
    expect(rules.enabled.has('particles')).toBe(false)
    expect(rules.enabled.has('weather')).toBe(false) // needs particles
    expect(rules.nodes.get('landscape')).toBe('subtree')
    expect(rules.nodes.get('weather')).toBe('subtree')
    expect(rules.shaderModules.has('wgsl/particleSim.wgsl')).toBe(true)
    expect(rules.shaderModules.has('wgsl/geometryTerrain.wgsl')).toBe(true)
    expect(featureStripRules([]).nodes.size).toBe(0)
  })

  it('removes a stripped node with its subtree, at any depth', () => {
    const scene = node('node', 'root', { children: [
      node('landscape', 'Ground', { children: [node('model', 'Rock')] }),
      node('node', 'Props', { children: [node('decal', 'Scorch'), node('model', 'Crate')] }),
    ] })
    const removed = stripFeatureNodes(scene, featureStripRules(['landscape', 'decals']))
    expect(removed).toBe(2)
    expect(scene.children.map((c: any) => c.name)).toEqual(['Props'])
    expect(scene.children[0].children.map((c: any) => c.name)).toEqual(['Crate'])
  })

  it('keeps what a node-only strip carries, under a plain node in its place', () => {
    const body = node('characterBody2D', 'Hero', { characterBody2D: { walkSpeed: 4 }, position: [1, 2, 0], children: [node('animatedSprite', 'Sprite')] })
    const scene = node('node', 'root', { children: [body] })
    stripFeatureNodes(scene, featureStripRules(['physics2d']))
    const plain = scene.children[0]
    expect(plain.type).toBe('node')
    expect(plain.name).toBe('Hero')
    expect(plain.position).toEqual([1, 2, 0])
    expect(plain.characterBody2D).toBeUndefined()
    expect(plain.children.map((c: any) => c.name)).toEqual(['Sprite'])
  })

  it('turns off the render settings a left-out feature runs', () => {
    const render = { ssrEnabled: true, ssaoEnabled: true, ssilEnabled: true, bloomEnabled: true }
    stripFeatureSettings(render, featureStripRules(['ssr', 'ssil']))
    expect(render).toEqual({ ssrEnabled: false, ssaoEnabled: false, ssilEnabled: false, bloomEnabled: true })
  })
})

describe('what a game uses of the features', () => {
  const game = {
    scenes: {
      main: {
        name: 'Main',
        render: { ssrEnabled: true, ssaoEnabled: false },
        scene: node('node', 'root', { children: [
          node('node', 'World', { children: [node('landscape', 'Ground')] }),
          node('model', 'Statue', { model: { material: { type: 'cel' } } }),
          node('node', 'Director', { script: "import { SequenceNode } from 'cleo'\nexport default class D { onStart() { SequenceNode } }" }),
          node('node', 'Plain', { script: 'const LandscapeNode = 1' }),
        ] }),
      },
    },
    templates: [{ name: 'Spark', node: node('particleSystem', 'Spark') }],
    modules: { '/Shared/Fx': "import { DecalNode } from 'cleo'" },
  }

  it('finds nodes, materials, render settings and the engine names scripts import', () => {
    const usage = featureUsage(game)
    expect(usage.get('landscape')).toEqual([{ where: 'Main ▸ World/Ground', what: 'Landscape node' }])
    expect(usage.get('celShading')?.[0]).toEqual({ where: 'Main ▸ Statue', what: 'cel material' })
    expect(usage.get('ssr')).toEqual([{ where: 'Main render settings', what: 'ssrEnabled' }])
    expect(usage.has('ssil')).toBe(false) // ssaoEnabled is off
    expect(usage.get('sequencer')).toEqual([{ where: 'Main ▸ Director', what: 'its script uses SequenceNode' }])
    expect(usage.get('particles')?.[0].where).toBe('template Spark')
    expect(usage.get('decals')).toEqual([{ where: 'script /Shared/Fx', what: 'uses DecalNode' }])
  })

  it('counts a render setting only where it runs: a feature without volumes, in a 3D scene', () => {
    const scene = node('node', 'root')
    const render = { ssrEnabled: true, giEnabled: true, volumetricFogEnabled: true }
    const in3D = featureUsage({ scenes: { a: { name: 'A', scene, render } } })
    expect([...in3D.keys()]).toEqual(['ssr'])
    expect(featureUsage({ scenes: { a: { name: 'A', scene, render, dimension: '2D' } } }).size).toBe(0)
  })

  it('sees what a node uses beyond its type: 2D areas, AI-driven controllers, cloth on a model', () => {
    const scene = node('node', 'root', { children: [
      node('trigger', 'Pickup'),
      node('controller', 'Guard', { controlSource: 'ai' }),
      node('controller', 'Hero', { controlSource: 'player' }),
      node('model', 'Knight', { model: { skinnedCloth: { vertices: [0], weights: [1] } } }),
    ] })
    const in2D = featureUsage({ scenes: { a: { name: 'A', scene, dimension: '2D' } } })
    expect(in2D.get('physics2d')).toEqual([{ where: 'A ▸ Pickup', what: 'Trigger node in a 2D scene' }])
    expect(in2D.get('ai')).toEqual([{ where: 'A ▸ Guard', what: 'AI-driven controller' }])
    expect(in2D.get('cloth')).toEqual([{ where: 'A ▸ Knight', what: 'cloth parts on its model' }])
    // A 3D trigger is the 3D physics', which is always shipped.
    expect(featureUsage({ scenes: { a: { name: 'A', scene, dimension: '3D' } } }).has('physics2d')).toBe(false)
  })

  it('sees the 2D physics world a script reaches through its scene, import or not', () => {
    const usage = featureUsage({ scenes: {}, modules: { '/Probe': 'export function ground(s) { return s.physics2D.raycast(0, 0, 0, -1, 9) }' } })
    expect(usage.get('physics2d')).toEqual([{ where: 'script /Probe', what: 'uses scene.physics2D' }])
  })

  it("reads a script's use of any name a feature's module adds, not only its node class", () => {
    const usage = featureUsage({ scenes: {}, modules: { '/Fx': "import { decalFlipbookFrame, VOLUMETRIC_FOG_PRESETS } from 'cleo'" } })
    expect(usage.get('decals')).toEqual([{ where: 'script /Fx', what: 'uses decalFlipbookFrame' }])
    expect(usage.get('volumetricFog')).toEqual([{ where: 'script /Fx', what: 'uses VOLUMETRIC_FOG_PRESETS' }])
  })

  it('does not take a name for the feature in a script that never imports the engine', () => {
    const usage = featureUsage(game)
    expect(usage.get('landscape')?.some(u => u.where.includes('Plain'))).toBe(false)
  })

  it('keeps only the uses of the features left out', () => {
    const uses = disabledFeatureUses(featureUsage(game), featureStripRules(['landscape', 'gi']).enabled)
    expect([...uses.keys()]).toEqual(['landscape'])
  })
})
