import { describe, it, expect, vi, afterEach } from 'vitest'
import { DecalNode, Material, Logger, Node, Scene } from 'cleo'
import {
  MATERIAL_ID_VAR, getNodeMaterial, nodeSupportsMaterial, canLinkMaterial, isProjectableMaterial,
  defaultDecalMaterial, seedDecalMaterial, applyMaterialAsset, unlinkToFallback, unlinkMaterialAt,
  materialSlotsReferencing, resolveMaterialRefs, buildMaterialAsset,
} from '../src/utils/materials'
import type { MaterialAsset } from '../src/utils/materials'
import { resyncScene } from '../src/utils/sceneResync'

/**
 * A decal links, saves, propagates and deletes its material exactly like a model — through the same
 * helpers and the same `__materialId` link — with one difference the helpers must enforce: it can only
 * project PBR. `DecalNode`'s setter already refuses anything else, but it refuses by storing null, which
 * projects plain white and reads as the link having silently worked. So every editor path has to refuse
 * first, and keep the decal's last good material.
 *
 * The real `cleo` rather than a mock: the point is that these helpers and the real `DecalNode` agree.
 */

const asset = (id: string, material: any): MaterialAsset => ({ id, name: id, material, thumbnail: '' })
const pbrAsset = (id: string, baseColor = [0.2, 0.4, 0.6]) =>
  buildMaterialAsset(Material.PBR({ baseColor, roughness: 0.3 }), id, '', id)
const blinnAsset = (id: string) => buildMaterialAsset(Material.Default({}), id, '', id)

afterEach(() => { vi.restoreAllMocks() })

describe('material helpers accept a decal', () => {
  it('reports that a decal carries a material, and reads the projected one', () => {
    const material = Material.PBR()
    const decal = new DecalNode('decal', { material })
    expect(nodeSupportsMaterial(decal)).toBe(true)
    expect(getNodeMaterial(decal)).toBe(material)
    expect(getNodeMaterial(new DecalNode('bare'))).toBeNull()
  })

  it('still reports a plain node as material-less', () => {
    expect(nodeSupportsMaterial(new Node('plain'))).toBe(false)
    expect(getNodeMaterial(new Node('plain'))).toBeNull()
  })

  it('links a PBR asset: the material is rebuilt from the asset and the link is stamped', () => {
    const decal = new DecalNode('decal')
    expect(applyMaterialAsset(decal, pbrAsset('mat-a'))).toBe(true)
    expect(decal.material?.type).toBe('pbr')
    expect(decal.material?.properties.get('baseColor')).toEqual([0.2, 0.4, 0.6])
    expect(decal.getVariable(MATERIAL_ID_VAR)).toBe('mat-a')
    expect(materialSlotsReferencing(decal, 'mat-a')).toEqual([0])
  })

  it('the placeholder a new decal starts with is one it accepts', () => {
    const decal = new DecalNode('decal', { material: defaultDecalMaterial() })
    expect(decal.material).not.toBeNull()
    expect(isProjectableMaterial(decal.material!.serialize())).toBe(true)
  })
})

describe('canLinkMaterial: a decal refuses non-PBR materials', () => {
  it('accepts PBR and refuses Basic, Blinn-Phong, Cel and custom materials', () => {
    const decal = new DecalNode('decal')
    expect(canLinkMaterial(decal, pbrAsset('p'))).toBe(true)
    expect(canLinkMaterial(decal, blinnAsset('b'))).toBe(false)
    expect(canLinkMaterial(decal, buildMaterialAsset(Material.Basic({}), 'basic', ''))).toBe(false)
    expect(canLinkMaterial(decal, asset('cel', { type: 'cel' }))).toBe(false)
    expect(canLinkMaterial(decal, asset('custom', { type: 'customGeom:abc', customMaterial: true }))).toBe(false)
    expect(canLinkMaterial(decal, asset('broken', null))).toBe(false)
  })

  it('never restricts anything that is not a decal', () => {
    expect(canLinkMaterial(new Node('model-ish'), blinnAsset('b'))).toBe(true)
  })

  it('applyMaterialAsset refuses a non-PBR asset and leaves the decal exactly as it was', () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {})
    const decal = new DecalNode('decal')
    applyMaterialAsset(decal, pbrAsset('good'))
    const before = decal.material

    expect(applyMaterialAsset(decal, blinnAsset('bad'))).toBe(false)
    // Not replaced by null (which the DecalNode setter would have stored), and still linked to the old one.
    expect(decal.material).toBe(before)
    expect(decal.getVariable(MATERIAL_ID_VAR)).toBe('good')
    expect(warn).toHaveBeenCalled()
  })
})

describe('unlinking and seeding a decal', () => {
  it('falls back to the placeholder PBR material, not the Basic fallback it would refuse', () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {})
    for (const unlink of [(d: DecalNode) => unlinkToFallback(d), (d: DecalNode) => unlinkMaterialAt(d, 0)]) {
      const decal = new DecalNode('decal')
      applyMaterialAsset(decal, pbrAsset('mat-a'))
      unlink(decal)
      expect(decal.material?.type).toBe('pbr')
      expect(decal.getVariable(MATERIAL_ID_VAR)).toBeUndefined()
    }
    // The DecalNode setter warns whenever it is handed something it refuses; nothing here should be.
    expect(warn).not.toHaveBeenCalled()
  })

  it('seedDecalMaterial gives a material-less decal the placeholder, and touches nothing else', () => {
    const bare = new DecalNode('bare')
    seedDecalMaterial(bare)
    expect(bare.material?.type).toBe('pbr')

    const authored = Material.PBR({ baseColor: [1, 0, 0] })
    const decal = new DecalNode('decal', { material: authored })
    seedDecalMaterial(decal)
    expect(decal.material).toBe(authored)

    const plain = new Node('plain')
    expect(() => seedDecalMaterial(plain)).not.toThrow()
  })
})

describe('resolveMaterialRefs: the decal branch', () => {
  const linked = (id: string, material: any = { type: 'pbr', stale: true }) => ({
    name: 'decal',
    variables: { [MATERIAL_ID_VAR]: { type: 'string', value: id } },
    decal: { size: [2, 1, 2], material },
    children: [] as any[],
  })

  it('rewrites decal.material from the library asset the link names', () => {
    const lib = [pbrAsset('mat-a')]
    const json = linked('mat-a')
    resolveMaterialRefs(json, lib)
    expect(json.decal.material).toEqual(lib[0].material)
    // A deep copy: the asset's serialized material is shared library state.
    expect(json.decal.material).not.toBe(lib[0].material)
    expect(json.decal.size).toEqual([2, 1, 2])
  })

  it('resolves decals nested under other nodes', () => {
    const lib = [pbrAsset('mat-a')]
    const parent = { variables: {}, children: [linked('mat-a')] } as any
    resolveMaterialRefs(parent, lib)
    expect(parent.children[0].decal.material).toEqual(lib[0].material)
  })

  it('keeps the embedded copy when the asset is gone, or has become a non-PBR material', () => {
    const missing = linked('gone')
    resolveMaterialRefs(missing, [pbrAsset('mat-a')])
    expect(missing.decal.material).toEqual({ type: 'pbr', stale: true })

    const turned = linked('now-blinn')
    resolveMaterialRefs(turned, [blinnAsset('now-blinn')])
    expect(turned.decal.material).toEqual({ type: 'pbr', stale: true })
  })

  it('never gives a decal payload to a model, or a model payload to a decal', () => {
    const lib = [pbrAsset('mat-a')]
    const model = { variables: { [MATERIAL_ID_VAR]: { type: 'string', value: 'mat-a' } }, model: { material: { type: 'stale' } }, children: [] } as any
    resolveMaterialRefs(model, lib)
    expect(model.decal).toBeUndefined()
    expect(model.model.material).toEqual(lib[0].material)

    const decal = linked('mat-a') as any
    resolveMaterialRefs(decal, lib)
    expect(decal.model).toBeUndefined()
  })

  it('round-trips a real serialized decal into one projecting the library material', async () => {
    const decal = new DecalNode('decal', { material: Material.PBR({ baseColor: [1, 1, 1] }) })
    decal.setVariable(MATERIAL_ID_VAR, 'mat-a', 'string')
    const json = await decal.serialize()

    resolveMaterialRefs(json, [pbrAsset('mat-a', [0.1, 0.9, 0.3])])
    const parsed = DecalNode.optionsFromJson(json.decal)
    expect(parsed.material?.properties.get('baseColor')).toEqual([0.1, 0.9, 0.3])
  })
})

describe('resyncScene: a stored scene picks up its decals\' materials', () => {
  // The pass works on LIVE nodes through the same helpers, so it needs no decal branch of its own; this
  // pins that it really does reach a decal, and that a deleted asset leaves a projectable material behind.
  const libs = (materials: MaterialAsset[]) =>
    ({ materials, models: [], templates: [], terrainMaterials: [], scripts: [], tilesets: [], aiBrains: [] }) as any
  const maps = () => ({ scripts: new Map(), bodies: new Map(), triggers: new Map() })

  const sceneWithLinkedDecal = () => {
    const scene = new Scene()
    const decal = new DecalNode('decal', { material: Material.PBR({ baseColor: [1, 1, 1] }) })
    decal.setVariable(MATERIAL_ID_VAR, 'mat-a', 'string')
    scene.addNode(decal)
    return { scene, decal }
  }

  it('re-applies a changed asset to a placed decal', () => {
    const { scene, decal } = sceneWithLinkedDecal()
    try {
      expect(resyncScene(scene, maps(), libs([pbrAsset('mat-a', [0.5, 0.25, 0])]), undefined)).toBe(true)
      expect(decal.material?.properties.get('baseColor')).toEqual([0.5, 0.25, 0])
    } finally { scene.dispose() }
  })

  it('unlinks a decal whose asset was deleted, onto the placeholder rather than null', () => {
    const { scene, decal } = sceneWithLinkedDecal()
    try {
      resyncScene(scene, maps(), libs([]), undefined)
      expect(decal.getVariable(MATERIAL_ID_VAR)).toBeUndefined()
      expect(decal.material?.type).toBe('pbr')
    } finally { scene.dispose() }
  })
})
