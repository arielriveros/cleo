// The Creator sync: mirrors the shared Creator library (app-kit creatorLibrary) into the open project.
//
// On start it applies every asset the project is behind on; after that it follows the library's channel,
// so an edit in the Creator window reaches this project's /Creator folder within a second or two. What
// each Creator asset becomes:
//
//   foliage  a model with its LOD levels embedded, a material per mesh part, and -- for a tree -- the
//            Creator's octahedral impostor, which a foliage rule made from the model starts with;
//   fx       the flipbook atlases as textures, and a particle system drawing the flipbook; for a liquid
//            with a floor decal, two decal materials too: the settled pool, and its animated atlases;
//   world    the heightmap and the masks as textures. The splat and weight maps stay in the library: a
//            landscape reads them, with the heightmap at full precision, through Import world (the
//            Landscape inspector's From Creator ▾).
//   character  a rigged model uploaded to the Creator: one `.anim` per clip it keeps (renamed there), on
//            its skeleton's rig. The model itself is not imported -- the editor imports models with + Add --
//            but any model on the same skeleton plays the clips.
//   motion   an `.anim` asset: the baked clip in the source skeleton's space, on the rig that skeleton
//            already is in the project (the mannequin's) or a new one, linked to it -- so every character
//            built on or retargeted from that rig can play it.
//   pose     a Pose asset holding the one pose, on its skeleton's rig, under fixed ids -- an animator state
//            holds a pose by id, so a re-sync must land on the same one.
//
// Clips are the Creator's except for their EVENTS: the Creator does not author events, the editor places
// them on the clip, so a re-sync keeps each clip's events (keepClipEvents) and replaces everything else.
//
// Editor ids are derived from the Creator id (creatorLinks.ts), so a re-sync replaces in place: placed
// models, foliage rules and particle nodes follow through the same propagation a save uses. An asset
// deleted in the Creator is removed from the project, unless the project uses it -- then it stays, in
// /Creator/Removed.
//
// The work is serial, one asset at a time, and a newer revision of an asset replaces any queued one.

import { Logger, Material, ModelNode, TextureManager, type Node } from 'cleo'
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
import type { AnimationAsset, StoredClip, StoredSkin } from '../../utils/animationAssets'
import type { RigAsset } from '../../utils/rigAssets'
import type { PoseAsset } from '../../utils/poseAssets'
import {
  creatorFolder, creatorIds, isWorldImportData, keepClipEvents, planCreatorSync, REMOVED_FOLDER, type CreatorLink, type CreatorLinks,
} from './creatorLinks'
import { pinKey, setCreatorPins } from './creatorPins'

const LINKS_KEY = 'cleo_creator_links'

/** The part of an FX sidecar's `outputs.decal` the sync reads: the files of each map. */
interface DecalSidecar {
  atlas?: { color: string; normal: string; orm: string };
  still?: { color: string; normal: string; orm: string };
}

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
  animations(): AnimationAsset[]
  /** Add or replace an animation asset. */
  putAnimation(asset: AnimationAsset): void
  removeAnimation(id: string): void
  /** The project's rig for this skeleton, reusing an equivalent one or adding it. */
  ensureRig(skin: StoredSkin, name: string): RigAsset | null
  /** List the animation on the rig, so models on (or retargeted from) it play it. */
  linkAnimationToRig(rigId: string, animationId: string): void
  /** Add or replace a pose asset. */
  putPoseAsset(asset: PoseAsset): void
  removePoseAsset(id: string): void
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
    let next: CreatorLink | null
    switch (meta.kind) {
      case 'foliage': next = await this.upsertFoliage(meta, files, link); break
      case 'fx': next = await this.upsertFx(meta, files, link); break
      case 'motion': next = await this.upsertMotion(meta, files); break
      case 'character': next = await this.upsertCharacter(meta, files, link); break
      case 'pose': next = await this.upsertPose(meta, files); break
      case 'world': next = await this.upsertWorld(meta, files, link); break
      // A kind from a newer Creator: skipped, rather than built as something it is not.
      default: Logger.warn(`Cleo Creator asset "${meta.name}" is of a kind this editor does not know (${meta.kind})`, 'Creator'); return
    }
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

  /**
   * A liquid's floor decal as two PBR decal materials, over textures the PNG pass registered: the settled
   * pool (`decal`), usable on any decal as it is, and the animated atlases (`decal_anim`), for a decal
   * given the sidecar's flipbook. Each map is base colour + coverage, the relief normal, and ORM.
   */
  private putDecalMaterials(meta: CreatorAssetMeta, decal: DecalSidecar | undefined): string[] {
    if (!decal?.still || !decal.atlas) return []
    const ids: string[] = []
    for (const [part, label, files] of [['decal', 'Decal', decal.still], ['decal_anim', 'Decal (animated)', decal.atlas]] as const) {
      const tex = (file: string) => creatorIds.texture(meta.id, file)
      const id = creatorIds.material(meta.id, part)
      const material = Material.PBR({
        baseColor: [1, 1, 1], roughness: 1, metallic: 0,
        textures: { baseColorTexture: tex(files.color), normalMap: tex(files.normal), roughnessMap: tex(files.orm), metallicMap: tex(files.orm), occlusionMap: tex(files.orm) },
      })
      const existing = this.host.materials().find(m => m.id === id)
      this.host.putMaterial(buildMaterialAsset(material, `${meta.name} ${label}`, existing?.thumbnail ?? '', id))
      ids.push(id)
    }
    return ids
  }

  private async upsertFx(meta: CreatorAssetMeta, files: CreatorFile[], prev: CreatorLink | undefined): Promise<CreatorLink | null> {
    const output = (meta.sidecar?.output ?? {}) as { particleFlipbook?: Record<string, unknown>; outputs?: Record<string, unknown>; medium?: string }
    // The colour atlas: `<name>_flipbook.png`, not one of the other atlases that share the suffix.
    const atlas = files.find(f => /_flipbook\.png$/i.test(f.name) && !/_(albedo|normal|orm|decal|decal_normal|decal_orm)_flipbook\.png$/i.test(f.name))
    if (!atlas || !output.particleFlipbook) return null
    const folder = creatorFolder('fx', meta.name)
    const flipId = creatorIds.texture(meta.id, 'flipbook')
    const textureIds: string[] = []
    // Every atlas: the flipbook, and the six-way, motion, surface and decal maps when the bake wrote them.
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
    // Surface maps: the emitter draws the unlit base colour, lit by the scene, with the normal and ORM
    // maps, their factors at 1 so the maps' roughness and metallic land as baked.
    const surface = output.outputs?.surface as { albedo?: string; normal?: string; orm?: string } | undefined
    const mapId = (file?: string) => (file ? creatorIds.texture(meta.id, file) : null)
    const albedoId = mapId(surface?.albedo), normalId = mapId(surface?.normal), ormId = mapId(surface?.orm)
    const surfaced = !!(albedoId && normalId && ormId)
    const draw = (render: ParticleSystemAsset['system']['emitters'][number]['render']) => {
      const wasSurfaced = !!render.ormTextureId && render.textureId !== flipId
      render.textureId = surfaced ? albedoId : flipId
      render.normalTextureId = surfaced ? normalId : null
      render.ormTextureId = surfaced ? ormId : null
      if (surfaced) { render.lit = true; render.roughness = 1; render.metallic = 1 }
      else if (wasSurfaced) { render.roughness = 1; render.metallic = 0 }
      render.flipbook = { ...render.flipbook, ...flipbook }
    }
    let asset: ParticleSystemAsset
    if (existing) {
      // Only what the Creator owns changes: the atlases on the emitters drawing one of its textures.
      // Anything set here (spawn rate, colour over life, more emitters) survives the next bake.
      asset = structuredClone(existing)
      asset.name = meta.name
      const ours = new Set([flipId, ...textureIds, ...(prev?.textureIds ?? [])])
      for (const e of asset.system.emitters) if (e.render.textureId && ours.has(e.render.textureId)) draw(e.render)
    } else {
      asset = { ...buildParticleSystemAsset(meta.name), id: psId }
      const render = asset.system.emitters[0].render
      render.blend = 'alpha'
      // A liquid's tiles are its body colour, lit by the bake's neutral light: the scene lights them.
      if (output.medium === 'liquid') render.lit = true
      draw(render)
    }

    const materialIds = this.putDecalMaterials(meta, output.outputs?.decal as DecalSidecar | undefined)
    for (const id of prev?.materialIds ?? [])
      if (!materialIds.includes(id) && !this.host.isUsed('material', id)) this.host.removeMaterial(id)

    const link: CreatorLink = { kind: 'fx', name: meta.name, revision: meta.revision, folder, particleSystemId: psId, materialIds, textureIds }
    this.links = { ...this.links, [meta.id]: link }
    this.publishPins()
    this.host.commitParticleSystem(asset)
    this.host.texturesChanged()
    return link
  }

  // --- world --------------------------------------------------------------------------------------

  private async upsertWorld(meta: CreatorAssetMeta, files: CreatorFile[], prev: CreatorLink | undefined): Promise<CreatorLink | null> {
    // The splat and weight maps are not textures anyone draws with: Import world reads them straight
    // from the library into a landscape's paint masks. Registered, they would be 4-16 more large images
    // in every project, each re-uploaded on every re-sync.
    const pngs = files.filter(f => f.mime === 'image/png' && !isWorldImportData(f.name))
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

  // --- motion -------------------------------------------------------------------------------------

  private async upsertMotion(meta: CreatorAssetMeta, files: CreatorFile[]): Promise<CreatorLink | null> {
    const output = (meta.sidecar?.output ?? {}) as { anim?: string; rig?: string }
    const file = files.find(f => f.name === output.anim) ?? files.find(f => f.name.endsWith('.anim.json'))
    if (!file) return null
    const data = JSON.parse(await file.blob.text()) as { clips?: StoredClip[]; sourceSkin?: StoredSkin; rigName?: string }
    if (!data.clips?.length || !data.sourceSkin) return null
    const id = creatorIds.animation(meta.id)
    const rig = this.host.ensureRig(data.sourceSkin, data.rigName ?? output.rig ?? 'Rig')
    const existing = this.host.animations().find(a => a.id === id)
    // The clip is the Creator's, all but its events; anything else on the asset (its thumbnail) survives
    // the next bake too.
    const asset: AnimationAsset = {
      ...(existing ?? {}), id, name: meta.name,
      clips: keepClipEvents(data.clips.map(c => ({ ...c, name: meta.name })), existing?.clips),
      sourceSkin: data.sourceSkin, rigId: rig?.id, sourceFile: file.name,
    }
    this.host.putAnimation(asset)
    if (rig) this.host.linkAnimationToRig(rig.id, id)
    const link: CreatorLink = { kind: 'motion', name: meta.name, revision: meta.revision, folder: creatorFolder('motion', meta.name), animationId: id, materialIds: [], textureIds: [] }
    this.links = { ...this.links, [meta.id]: link }
    this.publishPins()
    return link
  }

  // --- character ----------------------------------------------------------------------------------

  private async upsertCharacter(meta: CreatorAssetMeta, files: CreatorFile[], prev: CreatorLink | undefined): Promise<CreatorLink | null> {
    const output = (meta.sidecar?.output ?? {}) as { anim?: string; poses?: string }
    const animFile = files.find(f => f.name === output.anim) ?? files.find(f => f.name.endsWith('.anim.json'))
    if (!animFile) return null
    const data = JSON.parse(await animFile.blob.text()) as { clips?: StoredClip[]; sourceSkin?: StoredSkin; rigName?: string }
    if (!data.sourceSkin) return null
    const rig = this.host.ensureRig(data.sourceSkin, data.rigName ?? meta.name)
    const animationIds: string[] = []
    for (const clip of data.clips ?? []) {
      const id = creatorIds.characterClip(meta.id, clip.name)
      if (animationIds.includes(id)) continue
      const existing = this.host.animations().find(a => a.id === id)
      this.host.putAnimation({
        ...(existing ?? {}), id, name: clip.name, clips: keepClipEvents([clip], existing?.clips),
        sourceSkin: data.sourceSkin, rigId: rig?.id, sourceFile: `${meta.name} (Creator)`,
      })
      if (rig) this.host.linkAnimationToRig(rig.id, id)
      animationIds.push(id)
    }
    // Clips the previous revision had and this one dropped (deleted or hidden in the Creator).
    for (const id of prev?.animationIds ?? [])
      if (!animationIds.includes(id) && !this.host.isUsed('animation', id)) this.host.removeAnimation(id)

    // Older Creator revisions exported the character's poses as one pose library beside its clips. Poses are
    // Pose assets of their own now, so a revision without the file retires the library -- unless a state
    // still holds one of its poses: then it is kept, and checked again on the next revision.
    let poseAssetId: string | undefined
    const posesFile = files.find(f => f.name === output.poses) ?? files.find(f => f.name.endsWith('.poses.json'))
    if (posesFile) {
      const p = JSON.parse(await posesFile.blob.text()) as { name?: string; poses?: PoseAsset['poses'] }
      poseAssetId = creatorIds.poseAsset(meta.id)
      this.host.putPoseAsset({ id: poseAssetId, name: p.name ?? `${meta.name} Poses`, ...(rig ? { rigId: rig.id } : {}), poses: p.poses ?? [] })
    } else if (prev?.poseAssetId) {
      if (this.host.isUsed('pose', prev.poseAssetId)) poseAssetId = prev.poseAssetId
      else this.host.removePoseAsset(prev.poseAssetId)
    }

    const link: CreatorLink = {
      kind: 'character', name: meta.name, revision: meta.revision, folder: creatorFolder('character', meta.name),
      animationIds, ...(poseAssetId ? { poseAssetId } : {}), materialIds: [], textureIds: [],
    }
    this.links = { ...this.links, [meta.id]: link }
    this.publishPins()
    return link
  }

  // --- pose ---------------------------------------------------------------------------------------

  /**
   * A Creator Pose asset: `<stem>.pose.json` = `{ name, rigName, sourceSkin, poses: [{ id, name, bones }] }`,
   * bones already in the editor's pose convention (deltas from rest, by bone name). It becomes a pose asset
   * holding that one pose, on the rig its skeleton already is in the project (or a new one).
   *
   * Both ids are fixed (creatorIds.pose / poseEntry): an animator state holds `{ assetId, poseId }`, so a
   * re-sync -- and the Creator renaming the pose -- must land on the same pair.
   */
  private async upsertPose(meta: CreatorAssetMeta, files: CreatorFile[]): Promise<CreatorLink | null> {
    const output = (meta.sidecar?.output ?? {}) as { pose?: string }
    const file = files.find(f => f.name === output.pose) ?? files.find(f => f.name.endsWith('.pose.json'))
    if (!file) return null
    const data = JSON.parse(await file.blob.text()) as { name?: string; rigName?: string; sourceSkin?: StoredSkin; poses?: PoseAsset['poses'] }
    const pose = data.poses?.[0]
    if (!pose) return null
    const rig = data.sourceSkin ? this.host.ensureRig(data.sourceSkin, data.rigName ?? meta.name) : null
    const poseAssetId = creatorIds.pose(meta.id)
    this.host.putPoseAsset({
      id: poseAssetId, name: meta.name, ...(rig ? { rigId: rig.id } : {}),
      poses: [{ ...pose, id: creatorIds.poseEntry(meta.id), name: meta.name, bones: pose.bones ?? [] }],
    })
    const link: CreatorLink = {
      kind: 'pose', name: meta.name, revision: meta.revision, folder: creatorFolder('pose', meta.name),
      poseAssetId, materialIds: [], textureIds: [],
    }
    this.links = { ...this.links, [meta.id]: link }
    this.publishPins()
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
      || (link.animationId && this.host.isUsed('animation', link.animationId, own))
      || (link.animationIds ?? []).some(a => this.host.isUsed('animation', a, own))
      || (link.poseAssetId && this.host.isUsed('pose', link.poseAssetId, own))
      || (link.particleSystemId && this.host.isUsed('particleSystem', link.particleSystemId, own))
      || link.materialIds.some(m => this.host.isUsed('material', m, own))
      || link.textureIds.some(t => this.host.isUsed('texture', t, own))
    if (used) {
      this.links = { ...this.links, [id]: { ...link, removed: true, folder: `${REMOVED_FOLDER}/${link.name}` } }
      Logger.warn(`"${link.name}" was deleted in Cleo Creator; this project still uses it, so it is kept in ${REMOVED_FOLDER}.`, 'Creator')
    } else {
      if (link.modelId) this.host.removeModel(link.modelId)
      if (link.particleSystemId) this.host.removeParticleSystem(link.particleSystemId)
      if (link.animationId) this.host.removeAnimation(link.animationId)
      for (const a of link.animationIds ?? []) this.host.removeAnimation(a)
      if (link.poseAssetId) this.host.removePoseAsset(link.poseAssetId)
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
      put('animation', link.animationId)
      for (const a of link.animationIds ?? []) put('animation', a)
      put('pose', link.poseAssetId)
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
