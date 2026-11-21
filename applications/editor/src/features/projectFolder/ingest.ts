// Writing what a folder holds into the editor's cache (IndexedDB) for one project, before its providers
// mount — they then load from the cache exactly as they always have.
//
// One path for a cold cache (everything is new) and a warm one (only what changed on disk): each library
// array is read, the assets the folder removed are dropped, the ones it changed are replaced where they
// stand and new ones appended. Nothing here may run for the open project while its providers are mounted:
// every key is addressed with an explicit project id, and the callers run it between unmount and mount.
//
// Three things a folder does not carry and the cache keeps: rendered thumbnails (encode blanks them, so a
// record coming back with an empty one takes the cached render back), the open scene, and the order of the
// model library's records when the folder does not say (path order).

import { Logger } from 'cleo'
import { idbDelete, idbGet, idbSet } from '@cleo/app-kit/utils/idb'
import {
  folderPendingKey, inputMapKey, libKey, metaKey, projectSettingsKey, sceneKey, vfsKey, type LibName,
} from '../../utils/storageKeys'
import { readModelLibrary, writeModelLibrary } from '../../utils/modelStore'
import { putTextures, deleteTextures } from '../../utils/textureStore'
import { putAudio, deleteAudio } from '../../utils/audioStore'
import { putGiBake, deleteGiBakes } from '../../utils/giBakeStore'
import { createFreshProjectMeta, type ProjectMeta, type SceneMeta } from '../../utils/sceneStorage'
import { buildTextureAsset, type TextureAsset } from '../../utils/textureAssets'
import { buildSoundSampleAsset, type SoundSampleAsset } from '../../utils/soundSamples'
import { baseOf, dirOf, joinPath, repairVfs, stemOf, SOURCE_FOLDER, type VfsIndex } from '../../utils/vfs'
import { isLodTextureId } from '../../utils/lodTextureIds'
import { LIB_OF_KIND } from '../../utils/folder/projectCodec'
import { encodeAsset } from '../../utils/folder/codec'
import { collisionKey, metaRelOf, relOfVfsPath } from '../../utils/folder/layout'
import type { DecodedEntry, FolderDelta } from '../../utils/folder/folderDelta'
import type { ModelAsset } from '../../utils/models'

export interface IngestResult {
  /** Files to write back to the folder: textures and sounds minted for raw files dropped in from outside. */
  fixes: Map<string, string>
  /** The project's name, as project.cleo has it (the registry follows it). */
  name?: string
  counts: { upserts: number; removed: number }
}

const byPathOrder = (a: DecodedEntry, b: DecodedEntry) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)

/** Keep the cached thumbnail of a record the folder gave back without one. Overwrites in place. */
function keepThumbnail(record: any, cached: any): void {
  if (!record || !cached) return
  if (record.thumbnail === '' && typeof cached.thumbnail === 'string' && cached.thumbnail) record.thumbnail = cached.thumbnail
}

export async function writeDeltaIntoCache(pid: string, delta: FolderDelta, opts: { cold: boolean }): Promise<IngestResult> {
  const fixes = new Map<string, string>()
  const upsertsByLib = new Map<string, DecodedEntry[]>()
  const removedByLib = new Map<string, Set<string>>()
  const scenesUp: DecodedEntry[] = []
  const scenesGone = new Set<string>()
  for (const e of [...delta.upserts].sort(byPathOrder)) {
    if (e.kind === 'scene') { scenesUp.push(e); continue }
    const lib = LIB_OF_KIND[e.kind]
    const list = upsertsByLib.get(lib)
    if (list) list.push(e); else upsertsByLib.set(lib, [e])
  }
  for (const r of delta.removed) {
    if (r.kind === 'scene') { scenesGone.add(r.guid); continue }
    const lib = LIB_OF_KIND[r.kind]
    const set = removedByLib.get(lib)
    if (set) set.add(r.guid); else removedByLib.set(lib, new Set([r.guid]))
  }

  // The array libraries.
  const libs = new Map<string, any[]>()
  const readLib = async (name: string): Promise<any[]> => {
    if (libs.has(name)) return libs.get(name)!
    const list = opts.cold ? [] : ((await idbGet<any[]>(libKey(name as LibName, pid))) ?? [])
    libs.set(name, list)
    return list
  }
  const dirty = new Set<string>()
  const allLibs = new Set<string>([...upsertsByLib.keys(), ...removedByLib.keys()])
  if (opts.cold) for (const name of Object.values(LIB_OF_KIND)) allLibs.add(name)
  for (const name of allLibs) {
    if (name === 'models') continue
    const before = await readLib(name)
    const gone = removedByLib.get(name) ?? new Set<string>()
    const up = upsertsByLib.get(name) ?? []
    const byId = new Map(before.map(r => [r.id, r]))
    let next = before.filter(r => !gone.has(r.id))
    for (const e of up) {
      keepThumbnail(e.record, byId.get(e.guid))
      const at = next.findIndex(r => r.id === e.guid)
      if (at >= 0) next[at] = e.record; else next.push(e.record)
    }
    libs.set(name, next)
    dirty.add(name)
  }

  // Models: one record per key, in the order the cache had them (or that the records say).
  const modelUps = upsertsByLib.get('models') ?? []
  const modelGone = removedByLib.get('models') ?? new Set<string>()
  if (opts.cold || modelUps.length || modelGone.size) {
    const prev: ModelAsset[] = opts.cold ? [] : await readModelLibrary(pid)
    const byId = new Map(prev.map(m => [m.id, m]))
    let next = prev.filter(m => !modelGone.has(m.id))
    for (const e of modelUps) {
      keepThumbnail(e.record, byId.get(e.guid))
      const at = next.findIndex(m => m.id === e.guid)
      if (at >= 0) next[at] = e.record; else next.push(e.record)
    }
    // A record that carries the cache's own `order` (every one that went through the cache does) keeps it.
    if (opts.cold) next = next.map((m, i) => [m, i] as const)
      .sort(([a, i], [b, j]) => ((a as any).order ?? 1e9) - ((b as any).order ?? 1e9) || i - j).map(([m]) => m)
    await writeModelLibrary(next, prev, pid)
  }

  // A raw file dropped in from outside has a record now, but nothing that USES it: an image gets a texture
  // and a sound file a sound sample, beside it (in the folder holding its Source/ folder), never at the root.
  const vfs: VfsIndex = { ...delta.vfs, entries: [...delta.vfs.entries] }
  const takenPaths = new Set(vfs.entries.map(e => collisionKey(e.path)))
  const placeBeside = (imagePath: string, ext: string) => {
    const dir = dirOf(imagePath)
    const home = baseOf(dir) === SOURCE_FOLDER ? dirOf(dir) : dir
    const stem = stemOf(baseOf(imagePath))
    let path = joinPath(home, `${stem}${ext}`)
    for (let n = 2; takenPaths.has(collisionKey(path)); n++) path = joinPath(home, `${stem} (${n})${ext}`)
    takenPaths.add(collisionKey(path))
    return path
  }
  const mintBeside = async (kind: 'texture' | 'soundSample', lib: 'textures' | 'soundSamples', entry: DecodedEntry) => {
    const records = await readLib(lib)
    const readers = kind === 'texture' ? (r: TextureAsset) => r.imageIds?.includes(entry.guid) : (r: SoundSampleAsset) => r.audioIds?.includes(entry.guid)
    if (records.some(readers as any) || !entry.path) return
    const path = placeBeside(entry.path, kind === 'texture' ? '.tex' : '.sound')
    const taken = new Set(records.map(r => r.id))
    let id = stemOf(baseOf(entry.path))
    for (let n = 2; taken.has(id); n++) id = `${stemOf(baseOf(entry.path))}-${n}`
    const record = kind === 'texture'
      ? buildTextureAsset(id, stemOf(baseOf(path)), { kind: 'image', imageId: entry.guid })
      : buildSoundSampleAsset(id, stemOf(baseOf(path)), { kind: 'audio', audioId: entry.guid })
    records.push(record)
    dirty.add(lib)
    vfs.entries.push({ path, kind, assetId: id, created: entry.created })
    const encoded = await encodeAsset({ kind, guid: id, record, created: entry.created })
    const rel = relOfVfsPath(path, kind)
    fixes.set(rel, encoded.content as string)
    fixes.set(metaRelOf(rel), encoded.meta)
  }
  for (const e of delta.upserts) {
    if (e.kind === 'image' && !isLodTextureId(e.guid)) await mintBeside('texture', 'textures', e)
    if (e.kind === 'audioSource') await mintBeside('soundSample', 'soundSamples', e)
  }

  for (const name of dirty) await idbSet(libKey(name as LibName, pid), libs.get(name)!)

  // Byte payloads: images and audio by their own id, bakes by theirs.
  const imageRows = delta.upserts.filter(e => e.kind === 'image' && e.bytes)
  if (imageRows.length) {
    await putTextures(imageRows.map(e => ({ id: e.guid, blob: new Blob([e.bytes!.bytes as BlobPart], { type: e.bytes!.mime }), mime: e.bytes!.mime, config: e.bytes!.config ?? {} })), pid)
  }
  const imagesGone = [...(removedByLib.get('images') ?? [])]
  if (imagesGone.length) await deleteTextures(imagesGone, pid)
  const audioRows = delta.upserts.filter(e => e.kind === 'audioSource' && e.bytes)
  if (audioRows.length) {
    await putAudio(audioRows.map(e => ({ id: e.guid, blob: new Blob([e.bytes!.bytes as BlobPart], { type: e.bytes!.mime }), mime: e.bytes!.mime })), pid)
  }
  const audioGone = [...(removedByLib.get('audioSources') ?? [])]
  if (audioGone.length) await deleteAudio(audioGone, pid)
  for (const bake of delta.bakes.put) await putGiBake(bake.id, bake.bytes, pid)
  if (delta.bakes.removed.length) await deleteGiBakes(delta.bakes.removed, pid)

  // Scenes and the project meta.
  for (const e of scenesUp) await idbSet(sceneKey(e.guid, pid), e.scene!.data)
  for (const id of scenesGone) await idbDelete(sceneKey(id, pid))
  const cachedMeta = opts.cold ? null : await idbGet<ProjectMeta>(metaKey(pid))
  if (opts.cold || scenesUp.length || scenesGone.size || delta.project) {
    const cachedScenes = new Map((cachedMeta?.scenes ?? []).map(s => [s.id, s]))
    let scenes: SceneMeta[] = (cachedMeta?.scenes ?? []).filter(s => !scenesGone.has(s.id))
    for (const e of scenesUp) {
      const meta: SceneMeta = { ...e.scene!.meta }
      const cached = cachedScenes.get(meta.id)
      if (cached?.thumbnail) meta.thumbnail = cached.thumbnail
      const at = scenes.findIndex(s => s.id === meta.id)
      if (at >= 0) scenes[at] = meta; else scenes.push(meta)
    }
    let meta: ProjectMeta
    if (!scenes.length) {
      meta = cachedMeta && !opts.cold ? cachedMeta : createFreshProjectMeta(delta.project?.prefs?.dimension)
    } else {
      const order = new Map(vfs.entries.filter(e => e.kind === 'scene').map((e, i) => [e.assetId, i]))
      scenes = scenes.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9))
      const main = delta.project?.mainScene ?? cachedMeta?.mainSceneId
      const mainSceneId = main && scenes.some(s => s.id === main) ? main : scenes[0].id
      const open = cachedMeta?.openSceneId
      const prefs = { ...(cachedMeta?.prefs ?? {}) }
      if (delta.project) {
        if (delta.project.prefs?.dimension) prefs.dimension = delta.project.prefs.dimension
        else delete prefs.dimension
      }
      meta = { version: 2, mainSceneId, openSceneId: open && scenes.some(s => s.id === open) ? open : mainSceneId, scenes, prefs }
    }
    await idbSet(metaKey(pid), meta)
  }

  await idbSet(vfsKey(pid), repairVfs(vfs).next)

  if (delta.settings !== undefined) {
    if (delta.settings === null) await idbDelete(projectSettingsKey(pid)); else await idbSet(projectSettingsKey(pid), delta.settings)
  }
  if (delta.inputMap !== undefined) {
    if (delta.inputMap === null) await idbDelete(inputMapKey(pid)); else await idbSet(inputMapKey(pid), delta.inputMap)
  }
  // A cold ingest starts the journal afresh: nothing in this cache is waiting for the disk.
  if (opts.cold) await idbDelete(folderPendingKey(pid))

  if (delta.blocked.length) Logger.warn(`${delta.blocked.length} file(s) in the project folder could not be read: ${delta.blocked.slice(0, 3).map(b => `${b.rel} (${b.message})`).join('; ')}`, 'Editor')
  return { fixes, name: delta.project?.name, counts: { upserts: delta.upserts.length, removed: delta.removed.length } }
}
