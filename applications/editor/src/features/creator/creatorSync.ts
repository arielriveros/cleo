// The Creator sync: mirrors the shared Creator library (app-kit creatorLibrary) into the open project.
//
// On start it applies every asset the project is behind on; after that it follows the library's channel,
// so an edit in the Creator window reaches this project's /Creator folder within a second or two. What
// each Creator asset becomes:
//
//   foliage  a model with its LOD levels embedded, a material per mesh part, and -- for a tree -- the
//            Creator's octahedral impostor, which a foliage rule made from the model starts with;
//   fx       the flipbook atlases as textures, and a particle system drawing the flipbook;
//   world    the heightmap and the masks as textures (a landscape imports the heightmap at full
//            precision through Import heightmap ▸ From Creator).
//
// Editor ids are derived from the Creator id (creatorLinks.ts), so a re-sync replaces in place: placed
// models, foliage rules and particle nodes follow through the same propagation a save uses. An asset
// deleted in the Creator is removed from the project, unless the project uses it -- then it stays, in
// /Creator/Removed.
//
// The work is serial, one asset at a time, and a newer revision of an asset replaces any queued one.

import { Logger, ModelNode, TextureManager, type Node } from 'cleo'
import {
  creatorChannel, getCreatorAsset, getCreatorFiles, listCreatorAssets, type CreatorAssetMeta, type CreatorFile,
} from '@cleo/app-kit/creatorLibrary'
import { idbGet, idbSet } from '@cleo/app-kit/utils/idb'
import { scoped } from '../../utils/projectScope'
import { parseBundleToRoot } from '../../utils/modelImport'
import { awaitSubtreeTexturesReady, impostorTextureId } from '../../utils/modelThumbnails'
import { octahedralNormalTextureId } from '../../utils/octahedralImpostorBake'
import { applyMaterialAsset, buildMaterialAsset, materialAssetTextureIds, type MaterialAsset } from '../../utils/materials'
import { buildModelAsset, type ModelAsset, type ModelLodDef } from '../../utils/models'
import { flattenModelAsset } from '../../utils/modelClips'
import { buildParticleSystemAsset, type ParticleSystemAsset } from '../../utils/particleSystems'
import { deleteTextures } from '../../utils/textureStore'
import type { AssetKind } from '../../utils/vfs'
import { creatorFolder, creatorIds, planCreatorSync, REMOVED_FOLDER, type CreatorLink, type CreatorLinks } from './creatorLinks'
import { pinKey, setCreatorPins } from './creatorPins'

const LINKS_KEY = 'cleo_creator_links'

/** What the sync needs from the editor: its libraries (current, not a render behind) and its commits. */
export interface CreatorSyncHost {
  models(): ModelAsset[]
  materials(): MaterialAsset[]
  particleSystems(): ParticleSystemAsset[]
  /** Add or replace a material. */
  putMaterial(asset: MaterialAsset): void
  /** Add or replace a model and carry it to placed copies, foliage rules and its thumbnail (as a save does). */
  commitModel(asset: ModelAsset): void
  /** Add or replace a particle system and re-embed it in the particle nodes that use it. */
  commitParticleSystem(asset: ParticleSystemAsset): void
  removeModel(id: string): void
  removeMaterial(id: string): void
  removeParticleSystem(id: string): void
  /** Whether a scene or another asset uses this one; `ignore` names referrers that do not count (`kind:id`). */
  isUsed(kind: AssetKind, id: string, ignore?: ReadonlySet<string>): boolean
  /** Every texture the libraries reference, leaving out the assets named (the ones being replaced). */
  referencedTextures(except: ReadonlySet<string>): Set<string>
  texturesChanged(): void
  /** Name the explorer's records of these textures (id -> readable name). */
  nameTextures(names: ReadonlyMap<string, string>): void
  /** Drop the explorer's records of textures that are gone. */
  forgetTextures(ids: string[]): void
}

/** A file of the asset as a File, which the importers take. */
const asFile = (f: CreatorFile) => new File([f.blob], f.name, { type: f.mime })

/** A PNG's width, from its header (the impostor atlas size a re-bake would use). */
async function pngWidth(blob: Blob): Promise<number> {
  const head = new DataView(await blob.slice(16, 20).arrayBuffer())
  return head.byteLength === 4 ? head.getUint32(0) : 0
}

const SLOT_LABEL: Record<string, string> = {
  baseColorTexture: 'Base Color', normalMap: 'Normal', metallicRoughnessTexture: 'ARM', occlusionMap: 'ARM',
  roughnessMap: 'Roughness', metallicMap: 'Metallic', emissiveMap: 'Emissive',
}

export class CreatorSync {
  private links: CreatorLinks = {}
  private queue = new Map<string, number>()
  private running = false
  private unsubscribe: (() => void) | null = null
  private disposed = false
  /** Texture id -> readable name, for the explorer. */
  private names = new Map<string, string>()

  constructor(private host: CreatorSyncHost) {}

  async start(): Promise<void> {
    try {
      this.links = (await idbGet<CreatorLinks>(scoped(LINKS_KEY))) ?? {}
    } catch { this.links = {} }
    this.publishPins()
    this.unsubscribe = creatorChannel().subscribe(msg => this.enqueue(msg.id, msg.revision))
    // A sync that dies here (no IndexedDB, a corrupt record) must not take the editor with it.
    try {
      const plan = planCreatorSync(await listCreatorAssets(), this.links)
      for (const a of plan.upsert) this.enqueue(a.id, a.revision)
      for (const id of plan.retire) this.enqueue(id, Number.MAX_SAFE_INTEGER)
    } catch (e) {
      Logger.warn(`Cleo Creator library unavailable: ${e}`, 'Creator')
    }
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe?.()
    this.queue.clear()
  }

  private enqueue(id: string, revision: number): void {
    if (this.disposed) return
    this.queue.set(id, Math.max(revision, this.queue.get(id) ?? 0))
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (!this.disposed && this.queue.size) {
        const [id] = this.queue.keys()
        this.queue.delete(id)
        try { await this.apply(id) }
        catch (e) { Logger.error(`Could not sync Creator asset ${id}: ${e}`, 'Creator') }
      }
    } finally {
      this.running = false
    }
  }

  /** Bring one Creator asset up to date in this project. */
  private async apply(id: string): Promise<void> {
    const meta = await getCreatorAsset(id)
    const link = this.links[id]
    if (!meta || meta.deleted) { if (link && !link.removed) await this.retire(id, link); return }
    if (!meta.fileNames.length) return
    if (link && !link.removed && link.revision >= meta.revision) return
    const files = await getCreatorFiles(id)
    const next = meta.kind === 'foliage' ? await this.upsertFoliage(meta, files, link)
      : meta.kind === 'fx' ? await this.upsertFx(meta, files, link)
      : await this.upsertWorld(meta, files, link)
    if (!next) return
    this.links = { ...this.links, [id]: next }
    await this.saveLinks()
    Logger.info(`Synced "${meta.name}" from Cleo Creator (revision ${meta.revision})`, 'Creator')
  }

  // --- foliage ------------------------------------------------------------------------------------

  private async upsertFoliage(meta: CreatorAssetMeta, files: CreatorFile[], prev: CreatorLink | undefined): Promise<CreatorLink | null> {
    const output = (meta.sidecar?.output ?? {}) as {
      lods?: { file: string; distance: number }[]; cullDistance?: number
      impostor?: { distance: number; albedo: string; normal: string; info?: unknown } | null
    }
    const levels = (output.lods ?? []).map(l => ({ ...l, file: files.find(f => f.name === l.file) })).filter(l => l.file)
    if (!levels.length) return null
    const folder = creatorFolder('foliage', meta.name)
    const modelId = creatorIds.model(meta.id)
    const tm = TextureManager.Instance
    const before = new Set(tm.textures.keys())

    // Every level, parsed through the importer the Import button uses (no review: the Creator wrote these).
    const roots: Node[] = []
    for (const level of levels) {
      const { root } = await parseBundleToRoot([asFile(level.file!)], meta.name)
      await awaitSubtreeTexturesReady(root)
      roots.push(root)
    }

    // One material per mesh part, by the part's name ("Bark", "Leaves", "Blades"...): the first level that
    // has the part defines it, every level links it, so all of them share one set of textures.
    const materials = new Map<string, MaterialAsset>()
    for (const root of roots) {
      for (const node of modelNodesOf(root)) {
        const part = node.name || 'Part'
        let asset = materials.get(part)
        if (!asset) {
          const mat = (node.model as any)?.material
          if (!mat) continue
          asset = buildMaterialAsset(mat, `${meta.name} ${part}`, this.host.materials().find(m => m.id === creatorIds.material(meta.id, part))?.thumbnail ?? '',
                                     creatorIds.material(meta.id, part))
          materials.set(part, asset)
          for (const [slot, texId] of Object.entries(asset.material?.textures ?? {}))
            if (typeof texId === 'string' && texId) this.names.set(texId, `${meta.name} ${part} ${SLOT_LABEL[slot] ?? slot}`)
        }
        applyMaterialAsset(node, asset)
      }
    }
    for (const m of materials.values()) this.host.putMaterial(m)

    const lods: ModelLodDef[] = []
    for (let i = 1; i < roots.length; i++) lods.push({ distance: levels[i].distance, nodeJson: await roots[i].serialize(), generated: true })
    const existing = this.host.models().find(m => m.id === modelId) ?? null
    const asset = flattenModelAsset(await buildModelAsset(roots[0], [...materials.values()].map(m => m.id), existing?.thumbnail ?? '',
                                                          modelId, lods, output.cullDistance, existing))
    asset.name = meta.name

    // The impostor: fixed ids, so a foliage rule that already draws it keeps pointing at it.
    const textureIds = new Set<string>([...materials.values()].flatMap(m => materialAssetTextureIds(m)))
    const imp = output.impostor
    const albedo = imp && files.find(f => f.name === imp.albedo)
    const normal = imp && files.find(f => f.name === imp.normal)
    if (imp && albedo && normal) {
      const textureId = impostorTextureId(modelId), normalId = octahedralNormalTextureId(modelId)
      await this.putTexture(textureId, albedo, { mipMap: true }, `${meta.name} Impostor`)
      await this.putTexture(normalId, normal, { mipMap: true }, `${meta.name} Impostor Normals`)
      asset.impostor = { distance: imp.distance, textureId, normalId, octahedral: imp.info, size: await pngWidth(albedo.blob) }
      textureIds.add(textureId); textureIds.add(normalId)
    } else delete asset.impostor

    // Textures this pass registered that nothing kept (the later levels' own copies), and the previous
    // revision's that nothing references any more.
    const stillUsed = this.host.referencedTextures(new Set([modelId, ...[...materials.values()].map(m => m.id)]))
    const strays = [...tm.textures.keys()].filter(id => !before.has(id) && !textureIds.has(id) && !stillUsed.has(id))
    const old = (prev?.textureIds ?? []).filter(id => !textureIds.has(id) && !stillUsed.has(id))
    await this.dropTextures([...strays, ...old])

    // Materials the previous revision had and this one does not (a tree that lost its leaves).
    for (const id of prev?.materialIds ?? [])
      if (![...materials.values()].some(m => m.id === id) && !this.host.isUsed('material', id, new Set([`model:${modelId}`]))) this.host.removeMaterial(id)

    const link: CreatorLink = {
      kind: 'foliage', name: meta.name, revision: meta.revision, folder, modelId,
      materialIds: [...materials.values()].map(m => m.id), textureIds: [...textureIds],
    }
    this.links = { ...this.links, [meta.id]: link }
    this.publishPins()
    this.host.commitModel(asset)
    this.host.texturesChanged()
    return link
  }

  // --- fx -----------------------------------------------------------------------------------------

  private async upsertFx(meta: CreatorAssetMeta, files: CreatorFile[], prev: CreatorLink | undefined): Promise<CreatorLink | null> {
    const output = (meta.sidecar?.output ?? {}) as { particleFlipbook?: Record<string, unknown>; outputs?: Record<string, unknown> }
    const atlas = files.find(f => /_flipbook\.png$/i.test(f.name))
    if (!atlas || !output.particleFlipbook) return null
    const folder = creatorFolder('fx', meta.name)
    const flipId = creatorIds.texture(meta.id, 'flipbook')
    const textureIds: string[] = []
    // Every atlas: the flipbook, and the six-way and motion maps when the bake wrote them.
    for (const f of files.filter(x => x.mime === 'image/png')) {
      const id = f === atlas ? flipId : creatorIds.texture(meta.id, f.name)
      const label = f === atlas ? 'Flipbook' : f.name.replace(/^.*?_/, '').replace(/\.png$/i, '').replace(/_/g, ' ')
      await this.putTexture(id, f, { mipMap: true }, `${meta.name} ${label}`)
      textureIds.push(id)
    }
    await this.dropTextures((prev?.textureIds ?? []).filter(id => !textureIds.includes(id) && !this.host.isUsed('texture', id)))

    const psId = creatorIds.particleSystem(meta.id)
    const existing = this.host.particleSystems().find(p => p.id === psId)
    const flipbook = output.particleFlipbook as any
    let asset: ParticleSystemAsset
    if (existing) {
      // Only what the Creator owns changes: the flipbook on the emitters drawing it. Anything set here
      // (spawn rate, colour over life, more emitters) survives the next bake.
      asset = structuredClone(existing)
      asset.name = meta.name
      for (const e of asset.system.emitters)
        if (e.render.textureId === flipId) e.render.flipbook = { ...e.render.flipbook, ...flipbook }
    } else {
      asset = { ...buildParticleSystemAsset(meta.name), id: psId }
      const render = asset.system.emitters[0].render
      render.textureId = flipId
      render.flipbook = { ...render.flipbook, ...flipbook }
      render.blend = 'alpha'
    }

    const link: CreatorLink = { kind: 'fx', name: meta.name, revision: meta.revision, folder, particleSystemId: psId, materialIds: [], textureIds }
    this.links = { ...this.links, [meta.id]: link }
    this.publishPins()
    this.host.commitParticleSystem(asset)
    this.host.texturesChanged()
    return link
  }

  // --- world --------------------------------------------------------------------------------------

  private async upsertWorld(meta: CreatorAssetMeta, files: CreatorFile[], prev: CreatorLink | undefined): Promise<CreatorLink | null> {
    const pngs = files.filter(f => f.mime === 'image/png')
    if (!pngs.length) return null
    const folder = creatorFolder('world', meta.name)
    const textureIds: string[] = []
    for (const f of pngs) {
      const id = creatorIds.texture(meta.id, f.name)
      const label = f.name.replace(/^.*?_/, '').replace(/\.png$/i, '').replace(/_/g, ' ')
      await this.putTexture(id, f, { mipMap: true, wrapping: 'clamp' }, `${meta.name} ${label}`)
      textureIds.push(id)
    }
    await this.dropTextures((prev?.textureIds ?? []).filter(id => !textureIds.includes(id) && !this.host.isUsed('texture', id)))
    const link: CreatorLink = { kind: 'world', name: meta.name, revision: meta.revision, folder, materialIds: [], textureIds }
    this.links = { ...this.links, [meta.id]: link }
    this.publishPins()
    this.host.texturesChanged()
    return link
  }

  // --- deletion -----------------------------------------------------------------------------------

  /** The Creator deleted the asset: drop it from the project, or keep what the project still uses. */
  private async retire(id: string, link: CreatorLink): Promise<void> {
    // The asset's own parts referring to each other (its model to its materials) are not a use.
    const own = new Set([
      ...(link.modelId ? [`model:${link.modelId}`] : []), ...(link.particleSystemId ? [`particleSystem:${link.particleSystemId}`] : []),
      ...link.materialIds.map(m => `material:${m}`),
    ])
    const used = (link.modelId && this.host.isUsed('model', link.modelId, own))
      || (link.particleSystemId && this.host.isUsed('particleSystem', link.particleSystemId, own))
      || link.materialIds.some(m => this.host.isUsed('material', m, own))
      || link.textureIds.some(t => this.host.isUsed('texture', t, own))
    if (used) {
      this.links = { ...this.links, [id]: { ...link, removed: true, folder: `${REMOVED_FOLDER}/${link.name}` } }
      Logger.warn(`"${link.name}" was deleted in Cleo Creator; this project still uses it, so it is kept in ${REMOVED_FOLDER}.`, 'Creator')
    } else {
      if (link.modelId) this.host.removeModel(link.modelId)
      if (link.particleSystemId) this.host.removeParticleSystem(link.particleSystemId)
      for (const m of link.materialIds) this.host.removeMaterial(m)
      await this.dropTextures(link.textureIds)
      const { [id]: _, ...rest } = this.links
      this.links = rest
      Logger.info(`"${link.name}" was deleted in Cleo Creator and removed from this project.`, 'Creator')
    }
    this.publishPins()
    this.host.texturesChanged()
    await this.saveLinks()
  }

  // --- helpers ------------------------------------------------------------------------------------

  /** Register (or replace) a texture under a fixed id, from a file of the asset. */
  private async putTexture(id: string, file: CreatorFile, config: Record<string, unknown>, name: string): Promise<void> {
    // The stored record goes first: persistTextures skips an id it already holds, so a replaced texture
    // would otherwise only live in memory until the next reload brought the old one back.
    await deleteTextures([id])
    const tm = TextureManager.Instance
    tm.removeTexture(id)
    tm.addTextureFromFile(asFile(file), config as any, id)
    this.names.set(id, name)
  }

  private async dropTextures(ids: string[]): Promise<void> {
    if (!ids.length) return
    await deleteTextures(ids)
    for (const id of ids) { TextureManager.Instance.removeTexture(id); this.names.delete(id) }
    this.host.forgetTextures(ids)
  }

  private async saveLinks(): Promise<void> {
    try { await idbSet(scoped(LINKS_KEY), this.links) }
    catch (e) { Logger.warn(`Could not store the Creator links: ${e}`, 'Creator') }
  }

  /** Tell the explorer where every synced asset lives, and what its textures are called. */
  private publishPins(): void {
    const folders = new Map<string, string>()
    for (const link of Object.values(this.links)) {
      const put = (kind: AssetKind, id: string | undefined) => { if (id) folders.set(pinKey(kind, id), link.folder) }
      put('model', link.modelId)
      put('particleSystem', link.particleSystemId)
      for (const m of link.materialIds) put('material', m)
      for (const t of link.textureIds) { put('texture', t); put('image', t) }
    }
    setCreatorPins({ folders, names: new Map(this.names) })
    this.host.nameTextures(this.names)
  }
}

/** Every ModelNode at or below `root`. */
function modelNodesOf(root: Node): ModelNode[] {
  const out: ModelNode[] = []
  const walk = (n: Node) => { if (n instanceof ModelNode) out.push(n); for (const c of n.children) walk(c) }
  walk(root)
  return out
}
