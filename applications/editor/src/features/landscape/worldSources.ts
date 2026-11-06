import { decodeHeightmap, type HeightImage } from 'cleo/terrain/heightmapIO'
import { decodePngChannels, readWorldManifest, weightPlanesFromImages, type DecodedPng, type WorldManifest } from 'cleo/terrain/splatmapIO'

// Where Import world reads a world from: the Creator library's files, files picked from disk, or a zip of
// them. Every source becomes a list of named entries read on demand, and one loader turns that into the
// heightmap, the manifest and the layers' weight planes -- decoding only the files the manifest names.

/** One file of a world, its bytes read only when needed. */
export interface WorldEntry {
  name: string
  read: () => Promise<Uint8Array>
}

/** A world ready for the import dialog. */
export interface LoadedWorld {
  /** Shown in the dialog; also names a landscape material the import creates. */
  name: string
  manifest: WorldManifest
  height: HeightImage
  heightFile: string
  /** The layers' weight planes in manifest order; null when the world has no surfaces or they could not be read. */
  weights: { size: number; planes: Uint8Array[] } | null
  /** Why the surfaces could not be read, when the manifest lists some. */
  weightsError?: string
  /** Set for a Creator library world: what the landscape remembers for Re-apply. */
  creator?: { id: string; revision: number; exportHash?: string }
}

const baseName = (file: string) => (file.split(/[\\/]/).pop() ?? file)
const keyOf = (file: string) => baseName(file).toLowerCase()

/** Entries from picked files; a picked .zip contributes its files instead of itself. */
export async function entriesFromFiles(files: readonly File[]): Promise<WorldEntry[]> {
  const out: WorldEntry[] = []
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      // Loaded on first use: only a world zip needs the reader.
      const { default: JSZip } = await import('jszip')
      const zip = await JSZip.loadAsync(await file.arrayBuffer())
      zip.forEach((path, entry) => {
        if (!entry.dir) out.push({ name: baseName(path), read: () => entry.async('uint8array') })
      })
    } else {
      out.push({ name: file.name, read: async () => new Uint8Array(await file.arrayBuffer()) })
    }
  }
  return out
}

/** Entries from a Creator library asset's files. */
export function entriesFromBlobs(files: readonly { name: string; blob: Blob }[]): WorldEntry[] {
  return files.map(f => ({ name: f.name, read: async () => new Uint8Array(await f.blob.arrayBuffer()) }))
}

/** The manifest among the entries: the first `.json` that reads as a world sidecar or manifest. */
async function findManifest(entries: readonly WorldEntry[]): Promise<{ manifest: WorldManifest; file: string } | null> {
  for (const e of entries) {
    if (!/\.json$/i.test(e.name)) continue
    try {
      const manifest = readWorldManifest(JSON.parse(new TextDecoder().decode(await e.read())))
      if (manifest) return { manifest, file: e.name }
    } catch { /* not JSON, or not a world: keep looking */ }
  }
  return null
}

/**
 * Read a world. `sidecar` is the already-parsed manifest a Creator library asset carries; without one the
 * entries must include the `.json` the export wrote. The heightmap is required; the surfaces are read
 * from the splatmaps when every layer's file is there, else from the weightmaps, and a world whose maps
 * are missing still imports its heights (`weightsError` says why the surfaces did not come along).
 */
export async function loadWorld(entries: readonly WorldEntry[], opts: { name?: string; sidecar?: unknown; creator?: LoadedWorld['creator'] } = {}): Promise<LoadedWorld> {
  const byKey = new Map(entries.map(e => [keyOf(e.name), e]))
  const fromSidecar = opts.sidecar ? readWorldManifest(opts.sidecar) : null
  const found = fromSidecar ? { manifest: fromSidecar, file: '' } : await findManifest(entries)
  if (!found) throw new Error('none of the files is a world manifest (the .json a World export writes)')
  const { manifest } = found

  // PNG first (it carries its own size), then RAW at the manifest's resolution; anything named like a
  // heightmap when the manifest's own names are missing (a renamed download).
  const heightEntry = [manifest.heightmap.png, manifest.heightmap.raw].map(f => f && byKey.get(keyOf(f))).find(Boolean)
    ?? entries.find(e => /_height\.png$/i.test(e.name)) ?? entries.find(e => /_height\.(r16|raw)$/i.test(e.name))
  if (!heightEntry) throw new Error(`its heightmap (${manifest.heightmap.png ?? manifest.heightmap.raw ?? '_height.png'}) is not among the files`)
  const height = await decodeHeightmap(await heightEntry.read(), manifest.resolution)

  const name = opts.name ?? (found.file ? found.file.replace(/\.json$/i, '').replace(/\.world$/i, '') : 'World')
  const world: LoadedWorld = { name, manifest, height, heightFile: heightEntry.name, weights: null, creator: opts.creator }
  if (!manifest.layers.length) return world

  const has = (f: string | undefined) => !!f && byKey.has(keyOf(f))
  const splatOk = manifest.layers.every(l => has(l.splat?.file))
  const weightOk = manifest.layers.every(l => has(l.weightmap))
  if (!splatOk && !weightOk) {
    const missing = [...new Set(manifest.layers.map(l => l.splat?.file ?? l.weightmap ?? l.name).filter(f => !has(f)))]
    world.weightsError = `The surface maps are missing: ${missing.map(baseName).join(', ')}`
    return world
  }
  // weightPlanesFromImages prefers the splatmaps whenever every layer names one, so a world read from
  // its weightmaps alone is handed a manifest without the splat references.
  const readFrom: WorldManifest = splatOk ? manifest : { ...manifest, layers: manifest.layers.map(({ splat: _splat, ...l }) => l) }
  const files = [...new Set(readFrom.layers.map(l => (splatOk ? l.splat!.file : l.weightmap!)))]
  try {
    const images = new Map<string, DecodedPng>()
    for (const f of files) images.set(baseName(f), await decodePngChannels(await byKey.get(keyOf(f))!.read()))
    world.weights = weightPlanesFromImages(readFrom, images)
  } catch (err) {
    world.weightsError = `The surface maps could not be read: ${err instanceof Error ? err.message : err}`
  }
  return world
}
