// A whole project <-> the files of a folder project.
//
// The in-memory side is `BundleData`, the shape the export bundle, the example installer and the importer
// already share — so a folder can be written from anything a bundle can be read from, and read back into
// anything that takes a bundle. Two things a folder carries that a bundle never did: the Image and Texture
// records (`libraries.images` / `libraries.textures`), so texture names, settings and channel-pack specs
// survive; and per-asset metas, so identity survives git.
//
// Pure: no DOM, engine or Electron. Runs in the project worker and in Node tests.

import type { BundleAudio, BundleData, BundleGiBake, BundleLibraries, BundleTexture } from '../bundle'
import type { SceneAssetData, SceneMeta } from '../sceneStorage'
import type { ImageAsset } from '../images'
import type { ProjectPrefs } from '../projectStorage'
import { reconcileTextureAssets, buildTextureAsset, type LiveTexture, type TextureAsset } from '../textureAssets'
import { isLodTextureId } from '../lodTextureIds'
import {
  baseOf, dirOf, joinPath, reconcileVfs, repairVfs, stemOf, stemRepresents, isRawByteKind, SOURCE_FOLDER,
  type AssetKind, type LibSnapshot, type VfsEntry, type VfsIndex,
} from '../vfs'
import { BLOB_MIN_BYTES, decodeAsset, encodeAsset, readAssetJson, type AssetInput } from './codec'
import {
  ASSETS_DIR, DERIVED_DIR, INPUT_REL, PROJECT_FILE, SETTINGS_REL, bakeIdOfRel, bakeRel, collisionKey, derivedRel,
  dirOfRel, kindOfFileName, metaRelOf, nameOfRel, relOfVfsFolder, relOfVfsPath, roleOfRel, vfsFolderOfRel, vfsPathOfRel,
} from './layout'
import { parseJsonText, toJsonText } from './jsonText'
import { resolveIdentities, type BlockedFile, type FileFacts, type IdentityResult, type KnownEntry } from './identity'
import { metaText, recordWithFileSlot, type AssetMeta } from './meta'

// ---------------------------------------------------------------------------------------------------
// project.cleo
// ---------------------------------------------------------------------------------------------------

/** The folder format this build writes. A newer one is refused rather than half-read. */
export const FOLDER_FORMAT = 1

export interface ProjectFile {
  cleo: number
  format: number
  /** Stable across machines and moves: lets "Locate…" confirm a moved folder is the same project. */
  uid: string
  name: string
  /** The entry scene's guid. */
  mainScene?: string
  /** Only what describes the project; never editor state (no open scene, no selection). */
  prefs?: { dimension?: '2D' | '3D' }
}

export function projectFileText(file: ProjectFile): string {
  const out: Record<string, unknown> = { cleo: file.cleo, format: file.format, uid: file.uid, name: file.name }
  if (file.mainScene) out.mainScene = file.mainScene
  if (file.prefs && Object.keys(file.prefs).length) out.prefs = file.prefs
  return toJsonText(out)
}

export type ParsedProjectFile = { ok: true; file: ProjectFile } | { ok: false; message: string }

export function parseProjectFile(text: string): ParsedProjectFile {
  const parsed = parseJsonText(text)
  if (!parsed.ok) return { ok: false, message: `project.cleo: ${parsed.message}` }
  const v = parsed.value
  if (!v || typeof v !== 'object' || typeof v.uid !== 'string' || typeof v.name !== 'string')
    return { ok: false, message: 'project.cleo is not a Cleo project file' }
  const format = typeof v.format === 'number' ? v.format : 1
  if (format > FOLDER_FORMAT) return { ok: false, message: `this project was saved by a newer Cleo (folder format ${format})` }
  const file: ProjectFile = { cleo: typeof v.cleo === 'number' ? v.cleo : 1, format, uid: v.uid, name: v.name }
  if (typeof v.mainScene === 'string') file.mainScene = v.mainScene
  if (v.prefs && typeof v.prefs === 'object') {
    const prefs: ProjectFile['prefs'] = {}
    if (v.prefs.dimension === '2D' || v.prefs.dimension === '3D') prefs.dimension = v.prefs.dimension
    file.prefs = prefs
  }
  return { ok: true, file }
}

// ---------------------------------------------------------------------------------------------------
// Libraries by kind
// ---------------------------------------------------------------------------------------------------

/** The library each kind's records live in (scenes are not a library). */
export const LIB_OF_KIND = {
  material: 'materials', terrainMaterial: 'terrainMaterials', template: 'templates', model: 'models',
  script: 'scripts', animationField: 'animationFields', animation: 'animations', rig: 'rigs', tileset: 'tilesets',
  aiBrain: 'aiBrains', animController: 'animControllers', boneMask: 'boneMasks', pose: 'poseAssets',
  particleSystem: 'particleSystems', sequence: 'sequences', audioSource: 'audioSources', soundSample: 'soundSamples',
  image: 'images', texture: 'textures',
} as const satisfies Record<Exclude<AssetKind, 'scene'>, keyof FolderLibraries>

/** Every library a folder carries: the bundle's, plus the image and texture records. */
export type FolderLibraries = Required<Omit<BundleLibraries, 'inputMap' | 'projectSettings'>> & {
  images: ImageAsset[]
  textures: TextureAsset[]
}

export function emptyLibraries(): FolderLibraries {
  const out: any = {}
  for (const lib of Object.values(LIB_OF_KIND)) out[lib] = []
  return out
}

// ---------------------------------------------------------------------------------------------------
// The folder as files
// ---------------------------------------------------------------------------------------------------

/** A folder's content, as the codec writes it and reads it. Blobs are kept apart, by digest. */
export interface FolderSnapshot {
  /** rel -> content. Text files may be given as strings or bytes. */
  files: Map<string, string | Uint8Array>
  /** Directories under Assets/ that exist, empty ones included (rels). */
  dirs: string[]
  blobs: Map<string, Uint8Array>
  /** rel -> last modification time, when known (a scene's save time). */
  mtimes?: Map<string, number>
}

export interface WriteNote { rel?: string; message: string }

/** The image and texture records a bundle that predates them implies: what the editor would mint on open. */
export function deriveImageRecords(bundle: BundleData): { images: ImageAsset[]; textures: TextureAsset[] } {
  const lib = bundle.libraries as Partial<FolderLibraries>
  // A bundle that carries the records (a folder read back, or a bundle written after they were added) is
  // taken as it is: its payload rows are keyed by IMAGE id, which is not the list of live texture ids the
  // reconciler expects, so reconciling it would mint a texture per image.
  if (lib.images && lib.textures) return { images: lib.images, textures: lib.textures }
  const images = lib.images ?? []
  const textures = lib.textures ?? []
  const live: LiveTexture[] = (bundle.textures ?? []).map(t => ({
    id: t.id, config: t.config, width: 0, height: 0,
    source: { mime: t.mime, byteLength: (t.bytes as ArrayBuffer).byteLength },
  }))
  // Names from the bundle's own explorer entries, as VfsContext does: a bundle names every texture there
  // while its id may be a hash.
  const named = new Map<string, string>()
  for (const e of bundle.vfs?.entries ?? []) {
    if (e.kind === 'texture') named.set(`texture:${e.assetId}`, stemOf(baseOf(e.path)))
    else if (e.kind === 'image') named.set(`image:${e.assetId}`, baseOf(e.path))
  }
  const next = reconcileTextureAssets(live, images, textures, (kind, id) => named.get(`${kind}:${id}`))
  // A minted record is stamped with the time of minting; a folder written twice from one bundle must be the
  // same bytes, so it takes the time its explorer entry was made instead.
  const createdOf = new Map((bundle.vfs?.entries ?? []).filter(e => e.kind === 'image').map(e => [e.assetId, e.created ?? 0]))
  const had = new Set(images.map(i => i.id))
  const out = next.images.map(i => (had.has(i.id) ? i : { ...i, created: createdOf.get(i.id) ?? 0 }))
  return { images: out, textures: next.textures }
}

function libSnapshotOf(lib: FolderLibraries, scenes: SceneMeta[]): LibSnapshot {
  return {
    materials: lib.materials, terrainMaterials: lib.terrainMaterials, templates: lib.templates, models: lib.models,
    scripts: lib.scripts, animationFields: lib.animationFields, animations: lib.animations, rigs: lib.rigs,
    tilesets: lib.tilesets, aiBrains: lib.aiBrains, animControllers: lib.animControllers, boneMasks: lib.boneMasks,
    poseAssets: lib.poseAssets, particleSystems: lib.particleSystems, sequences: lib.sequences,
    scenes: scenes.map(s => ({ id: s.id, name: s.name, updatedAt: s.updatedAt })),
    // LOD twins never have an explorer entry: they go to Derived/.
    images: lib.images.filter(i => !isLodTextureId(i.id)),
    textures: lib.textures.filter(t => !isLodTextureId(t.id)),
    audioSources: lib.audioSources, soundSamples: lib.soundSamples,
    textureIds: lib.textures.map(t => t.id),
  }
}

/**
 * Make every explorer path a file path that is unique on a case-insensitive file system. A path that
 * collides is given the explorer's own ' (2)' suffix (which the reconciler accepts as still naming the
 * record); a byte kind's record is renamed to match, because its name IS its file name.
 */
function caseUniqueVfs(vfs: VfsIndex, rename: (e: VfsEntry, name: string) => void): VfsIndex {
  const taken = new Set<string>(vfs.folders.map(f => collisionKey(f)))
  const entries = vfs.entries.map(e => {
    let path = e.path
    if (taken.has(collisionKey(path))) {
      const base = baseOf(path)
      const dot = base.lastIndexOf('.')
      const stem = dot > 0 ? base.slice(0, dot) : base
      const ext = dot > 0 ? base.slice(dot) : ''
      let n = 2
      do path = joinPath(dirOf(e.path), `${stem} (${n++})${ext}`); while (taken.has(collisionKey(path)))
      if (isRawByteKind(e.kind)) rename(e, baseOf(path))
    }
    taken.add(collisionKey(path))
    return path === e.path ? e : { ...e, path }
  })
  return { ...vfs, entries }
}

export interface BundleToFolderOptions {
  uid: string
  name?: string
  minBytes?: number
}

/** Write a whole project, from a bundle, as the files of a folder. */
export async function bundleToFolder(
  input: BundleData,
  opts: BundleToFolderOptions,
): Promise<{ snapshot: FolderSnapshot; notes: WriteNote[] }> {
  const notes: WriteNote[] = []
  const minBytes = opts.minBytes ?? BLOB_MIN_BYTES
  const derived = deriveImageRecords(input)
  const lib: FolderLibraries = { ...emptyLibraries(), ...(input.libraries as any), images: derived.images, textures: derived.textures }
  for (const name of Object.values(LIB_OF_KIND)) if (!Array.isArray((lib as any)[name])) (lib as any)[name] = []

  const sceneMetas = input.manifest.sceneMetas ?? []
  let vfs = repairVfs(input.vfs).next
  vfs = reconcileVfs(vfs, libSnapshotOf(lib, sceneMetas), { prune: true, pruneTextures: true }).next
  vfs = caseUniqueVfs(vfs, (e, name) => {
    const record = (lib as any)[LIB_OF_KIND[e.kind as Exclude<AssetKind, 'scene'>]]?.find((r: any) => r.id === e.assetId)
    if (record) record.name = name
    notes.push({ message: `"${e.path}" clashes with another name on a case-insensitive disk; written as "${name}"` })
  })

  const files = new Map<string, string | Uint8Array>()
  const blobs = new Map<string, Uint8Array>()
  const dirs = new Set<string>([ASSETS_DIR])
  const imageBytes = new Map((input.textures ?? []).map(t => [t.id, t]))
  const audioBytes = new Map((input.audio ?? []).map(a => [a.id, a]))

  const put = async (rel: string, asset: AssetInput) => {
    const encoded = await encodeAsset(asset, minBytes)
    files.set(rel, encoded.content)
    files.set(metaRelOf(rel), encoded.meta)
    for (const [h, b] of encoded.blobs) if (!blobs.has(h)) blobs.set(h, b)
  }
  const bytesOf = (kind: AssetKind, id: string): AssetInput['bytes'] | undefined => {
    if (kind === 'image') {
      const t = imageBytes.get(id)
      return t ? { mime: t.mime, config: t.config, bytes: new Uint8Array(t.bytes) } : undefined
    }
    const a = audioBytes.get(id)
    return a ? { mime: a.mime, bytes: new Uint8Array(a.bytes) } : undefined
  }

  for (const folder of vfs.folders) dirs.add(relOfVfsFolder(folder))

  for (const entry of vfs.entries) {
    const rel = relOfVfsPath(entry.path, entry.kind)
    if (entry.kind === 'scene') {
      const meta = sceneMetas.find(m => m.id === entry.assetId)
      const data = input.scenes[entry.assetId]
      if (!meta || !data) { notes.push({ rel, message: 'a scene with no saved data was left out' }); continue }
      await put(rel, { kind: 'scene', guid: entry.assetId, created: entry.created, scene: { meta, data } })
      continue
    }
    const record = (lib as any)[LIB_OF_KIND[entry.kind]].find((r: any) => r.id === entry.assetId)
    if (!record) { notes.push({ rel, message: `no ${entry.kind} record ${entry.assetId}` }); continue }
    if (isRawByteKind(entry.kind)) {
      const bytes = bytesOf(entry.kind, entry.assetId)
      if (!bytes) { notes.push({ rel, message: `${entry.kind} ${entry.assetId} has no bytes; left out` }); continue }
      await put(rel, { kind: entry.kind, guid: entry.assetId, created: entry.created, record, bytes })
    } else {
      await put(rel, { kind: entry.kind, guid: entry.assetId, created: entry.created, record })
    }
  }

  // Records with no explorer entry that still ship: a LOD level's downscaled twins.
  for (const image of lib.images.filter(i => isLodTextureId(i.id))) {
    const bytes = bytesOf('image', image.id)
    if (!bytes) continue
    await put(derivedRel('image', image.id, ''), { kind: 'image', guid: image.id, created: image.created, record: image, bytes })
  }
  for (const texture of lib.textures.filter(t => isLodTextureId(t.id)))
    await put(derivedRel('texture', texture.id, ''), { kind: 'texture', guid: texture.id, record: texture })
  for (const bake of input.giBakes ?? []) files.set(bakeRel(bake.id), new Uint8Array(bake.bytes))

  const prefs: ProjectFile['prefs'] = {}
  if (input.manifest.prefs?.dimension) prefs.dimension = input.manifest.prefs.dimension
  const mainScene = input.manifest.mainSceneId && sceneMetas.some(m => m.id === input.manifest.mainSceneId)
    ? input.manifest.mainSceneId : sceneMetas[0]?.id
  files.set(PROJECT_FILE, projectFileText({
    cleo: 1, format: FOLDER_FORMAT, uid: opts.uid, name: opts.name ?? input.manifest.projectName ?? 'Project', mainScene, prefs,
  }))
  const settings = input.libraries.projectSettings
  if (settings) files.set(SETTINGS_REL, toJsonText(settings))
  const inputMap = input.libraries.inputMap
  if (inputMap) files.set(INPUT_REL, toJsonText(inputMap))

  return { snapshot: { files, dirs: [...dirs].sort(), blobs }, notes }
}

// ---------------------------------------------------------------------------------------------------
// Reading a folder
// ---------------------------------------------------------------------------------------------------

export interface FolderProblem { rel: string; reason: string; message: string }

export interface FolderReadResult {
  bundle: BundleData & { libraries: BundleLibraries & { images: ImageAsset[]; textures: TextureAsset[] } }
  project: ProjectFile
  identity: IdentityResult
  /** Files the editor cannot read now. Their cached versions must stay, and nothing may overwrite them. */
  blocked: FolderProblem[]
  /** Files the editor should write back: metas that were missing or wrong, re-minted ids, minted textures. */
  fixes: Map<string, string>
  /** rel -> the blob digests it references, for every asset read. */
  refs: Map<string, string[]>
  /** rel -> (kind, guid), for every asset read. */
  entries: Map<string, KnownEntry>
}

export interface ReadFolderOptions {
  known?: Map<string, KnownEntry>
  shaOf?: (rel: string) => string | undefined
  /** Name for the project when project.cleo is missing (a folder being adopted). */
  fallbackName?: string
  uid?: () => string
}

const asText = (content: string | Uint8Array): string =>
  typeof content === 'string' ? content : new TextDecoder().decode(content)

/** Read a whole folder back into a bundle the editor can load. */
export async function folderToBundle(snapshot: FolderSnapshot, opts: ReadFolderOptions = {}): Promise<FolderReadResult> {
  const blocked: FolderProblem[] = []
  const fixes = new Map<string, string>()
  const refs = new Map<string, string[]>()
  const entries = new Map<string, KnownEntry>()

  // project.cleo
  let project: ProjectFile
  const projectContent = snapshot.files.get(PROJECT_FILE)
  const parsedProject = projectContent !== undefined ? parseProjectFile(asText(projectContent)) : null
  if (parsedProject?.ok) project = parsedProject.file
  else {
    if (parsedProject && !parsedProject.ok) blocked.push({ rel: PROJECT_FILE, reason: 'invalid', message: parsedProject.message })
    project = { cleo: 1, format: FOLDER_FORMAT, uid: opts.uid?.() ?? '', name: opts.fallbackName ?? 'Project' }
  }

  // Classify.
  const assetFacts: FileFacts[] = []
  const metas = new Map<string, string>()
  const parsedJson = new Map<string, any>()
  const bakes: BundleGiBake[] = []
  const rels = [...snapshot.files.keys()].sort()
  for (const rel of rels) {
    const role = roleOfRel(rel)
    const content = snapshot.files.get(rel)!
    if (role === 'meta') { metas.set(rel, asText(content)); continue }
    if (role === 'bake') {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
      bakes.push({ id: bakeIdOfRel(rel)!, bytes: bytes.slice().buffer as ArrayBuffer })
      continue
    }
    if (role !== 'asset' && role !== 'derived') continue
    const facts: FileFacts = { rel, sha: opts.shaOf?.(rel) }
    // A JSON kind is parsed now: its `id` is identity rule 2, and a broken file is blocked before anything
    // is decided about it.
    const metaText0 = snapshot.files.get(metaRelOf(rel))
    const metaKind = metaText0 !== undefined ? (() => { try { return JSON.parse(asText(metaText0)).kind } catch { return undefined } })() : undefined
    const nameKind = metaKind ?? kindOfFileName(nameOfRel(rel))
    if (nameKind && !isRawByteKind(nameKind) && nameKind !== 'script') {
      const read = readAssetJson(asText(content))
      if (!read.ok) { blocked.push({ rel, reason: read.reason, message: read.message }); continue }
      parsedJson.set(rel, read.value)
      if (read.value && typeof read.value.id === 'string') facts.jsonId = read.value.id
    }
    assetFacts.push(facts)
  }

  const identity = resolveIdentities(assetFacts, metas, { known: opts.known })
  for (const b of identity.blocked) blocked.push(b as BlockedFile & { reason: string })
  const blockedRels = new Set(blocked.map(b => b.rel))

  const lib = emptyLibraries()
  const sceneMetas: SceneMeta[] = []
  const scenes: Record<string, SceneAssetData> = {}
  const textures: BundleTexture[] = []
  const audio: BundleAudio[] = []
  const vfsEntries: VfsEntry[] = []
  const getBlob = (h: string) => snapshot.blobs.get(h)

  for (const file of identity.files) {
    if (blockedRels.has(file.rel)) continue
    const content = snapshot.files.get(file.rel)!
    const decoded = await decodeAsset(file.meta, content, getBlob, { mtime: snapshot.mtimes?.get(file.rel), parsed: parsedJson.get(file.rel) })
    if (!decoded.ok) { blocked.push({ rel: file.rel, reason: decoded.reason, message: decoded.message }); continue }
    refs.set(file.rel, decoded.refs)
    entries.set(file.rel, { kind: file.kind, guid: file.guid, sha: opts.shaOf?.(file.rel) })

    let record: any
    const inAssets = file.rel.startsWith(ASSETS_DIR + '/')
    const path = inAssets ? vfsPathOfRel(file.rel, file.kind) : null
    const fileName = path ? baseOf(path) : ''

    if (file.kind === 'scene') {
      const name = stemOf(fileName)
      sceneMetas.push({ id: file.guid, name, ...decoded.scene!.meta })
      scenes[file.guid] = decoded.scene!.data
    } else {
      record = decoded.record
      if (!record) record = mintRecord(file.kind, file.guid, fileName, decoded.bytes)
      if (path) applyName(file.kind, record, fileName)
      ;(lib as any)[LIB_OF_KIND[file.kind]].push(record)
      if (file.kind === 'image' && decoded.bytes) textures.push({ id: file.guid, mime: decoded.bytes.mime || record.mime, config: decoded.bytes.config, bytes: decoded.bytes.bytes.slice().buffer as ArrayBuffer })
      if (file.kind === 'audioSource' && decoded.bytes) audio.push({ id: file.guid, mime: decoded.bytes.mime || record.mime, bytes: decoded.bytes.bytes.slice().buffer as ArrayBuffer })
    }
    if (path) vfsEntries.push({ path, kind: file.kind, assetId: file.guid, created: file.meta.created ?? 0 })

    // Write-backs: a missing or wrong meta, a re-minted id.
    if (file.writeMeta || file.rewriteId) {
      const meta: AssetMeta = { ...file.meta }
      if ((file.kind === 'image' || file.kind === 'audioSource') && decoded.bytes) {
        meta.record = { ...record }
        meta.importer = file.kind === 'image' ? { mime: decoded.bytes.mime, config: decoded.bytes.config } : { mime: decoded.bytes.mime }
      }
      if (file.kind === 'script' && record) meta.record = recordWithFileSlot(record, 'source')
      fixes.set(metaRelOf(file.rel), metaText(meta))
    }
    if (file.rewriteId && parsedJson.has(file.rel)) {
      // The file's own id follows the meta, in place: only the `id` value changes.
      const raw = parsedJson.get(file.rel)
      raw.id = file.guid
      fixes.set(file.rel, toJsonText(raw))
    }
  }

  // An image that arrived without a texture (dropped into Assets/ from outside) gets one beside it, in the
  // folder that holds its Source/ folder — never at the explorer root, where the reconciler would land it.
  const readByTexture = new Set(lib.textures.flatMap(t => t.imageIds ?? []))
  const takenPaths = new Set(vfsEntries.map(e => collisionKey(e.path)))
  for (const image of lib.images) {
    if (readByTexture.has(image.id) || isLodTextureId(image.id)) continue
    const entry = vfsEntries.find(e => e.kind === 'image' && e.assetId === image.id)
    if (!entry) continue
    const dir = dirOf(entry.path)
    const home = baseOf(dir) === SOURCE_FOLDER ? dirOf(dir) : dir
    const stem = stemOf(baseOf(entry.path))
    let path = joinPath(home, `${stem}.tex`)
    for (let n = 2; takenPaths.has(collisionKey(path)); n++) path = joinPath(home, `${stem} (${n}).tex`)
    takenPaths.add(collisionKey(path))
    const taken = new Set(lib.textures.map(t => t.id))
    let id = image.id
    for (let n = 2; taken.has(id); n++) id = `${image.id}-${n}`
    const texture = buildTextureAsset(id, stemOf(baseOf(path)), { kind: 'image', imageId: image.id })
    lib.textures.push(texture)
    vfsEntries.push({ path, kind: 'texture', assetId: id, created: image.created })
    const encoded = await encodeAsset({ kind: 'texture', guid: id, record: texture, created: image.created })
    const rel = relOfVfsPath(path, 'texture')
    fixes.set(rel, encoded.content as string)
    fixes.set(metaRelOf(rel), encoded.meta)
  }

  // Library order is state (a stable listing order); from a folder it is path order.
  const order = new Map(vfsEntries.map((e, i) => [`${e.kind}:${e.assetId}`, i]))
  for (const [kind, name] of Object.entries(LIB_OF_KIND) as [AssetKind, keyof FolderLibraries][]) {
    const list = (lib as any)[name] as any[]
    list.sort((a, b) => (order.get(`${kind}:${a.id}`) ?? 1e9) - (order.get(`${kind}:${b.id}`) ?? 1e9))
  }

  const folders = new Set<string>()
  for (const dir of snapshot.dirs) { const f = vfsFolderOfRel(dir); if (f && f !== '/') folders.add(f) }
  const vfs = repairVfs({ version: 1, folders: [...folders], entries: vfsEntries }).next

  const settingsContent = snapshot.files.get(SETTINGS_REL)
  const inputContent = snapshot.files.get(INPUT_REL)
  const readOptional = (rel: string, content: string | Uint8Array | undefined): unknown | null => {
    if (content === undefined) return null
    const parsed = parseJsonText(asText(content))
    if (parsed.ok) return parsed.value
    blocked.push({ rel, reason: parsed.reason, message: parsed.message })
    return null
  }
  const projectSettings = readOptional(SETTINGS_REL, settingsContent)
  const inputMap = readOptional(INPUT_REL, inputContent) as any

  const mainSceneId = project.mainScene && sceneMetas.some(s => s.id === project.mainScene) ? project.mainScene : sceneMetas[0]?.id
  const prefs: ProjectPrefs = {}
  if (project.prefs?.dimension) prefs.dimension = project.prefs.dimension

  const bundle = {
    manifest: {
      formatVersion: 2, kind: 'project' as const, createdAt: 0,
      mainSceneId, openSceneId: mainSceneId, sceneMetas, prefs, projectName: project.name,
    },
    scenes,
    libraries: { ...lib, projectSettings, inputMap },
    vfs,
    textures,
    audio,
    giBakes: bakes,
  }
  return { bundle, project, identity, blocked, fixes, refs, entries }
}

/** A raw file with no record anywhere (dropped in from outside): the record the explorer would make. */
function mintRecord(kind: AssetKind, id: string, fileName: string, bytes?: { mime: string; bytes: Uint8Array }): any {
  const created = Date.now()
  if (kind === 'image') return { id, name: fileName, mime: bytes?.mime || mimeOf(fileName), width: 0, height: 0, byteSize: bytes?.bytes.byteLength ?? 0, origin: 'upload', created }
  if (kind === 'audioSource') return { id, name: fileName, mime: bytes?.mime || mimeOf(fileName), duration: 0, sampleRate: 0, channels: 0, byteSize: bytes?.bytes.byteLength ?? 0, origin: 'upload', created }
  return { id, name: stemOf(fileName) }
}

/**
 * The file name has the last word on an asset's name: renaming a file outside the editor renames the asset.
 * A byte kind's name IS its file name; any other kind's name is the stem, unless the stem is the name with
 * the explorer's ' (2)' suffix (vfs.ts `stemRepresents`). Overwrites in place, never adds a key.
 */
function applyName(kind: AssetKind, record: any, fileName: string): void {
  if (!record || typeof record !== 'object') return
  if (isRawByteKind(kind)) { if (record.name !== fileName) record.name = fileName; return }
  const stem = stemOf(fileName)
  if (typeof record.name === 'string' && stemRepresents(stem, record.name)) return
  record.name = stem
  // A sequence keeps its name twice (assetKinds.renameAsset sets both).
  if (kind === 'sequence' && record.sequence && typeof record.sequence === 'object' && 'name' in record.sequence) record.sequence.name = stem
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.tga': 'image/x-tga', '.tiff': 'image/tiff', '.ktx2': 'image/ktx2', '.hdr': 'image/vnd.radiance',
  '.exr': 'image/x-exr', '.avif': 'image/avif',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.aac': 'audio/aac', '.opus': 'audio/opus', '.webm': 'audio/webm',
}
function mimeOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return MIME[dot >= 0 ? fileName.slice(dot).toLowerCase() : ''] ?? 'application/octet-stream'
}

/** Every directory a snapshot's files imply under Assets/ (for callers that only list files). */
export function dirsOfFiles(rels: Iterable<string>): string[] {
  const out = new Set<string>()
  for (const rel of rels) {
    if (!rel.startsWith(ASSETS_DIR + '/') && !rel.startsWith(DERIVED_DIR + '/')) continue
    let dir = dirOfRel(rel)
    while (dir && dir !== ASSETS_DIR && dir.startsWith(ASSETS_DIR)) { out.add(dir); dir = dirOfRel(dir) }
  }
  return [...out].sort()
}
