// Turns an arbitrary batch of picked/dropped files (and folders) into one bundle per model file, so
// several independent models — each with its own buffers/textures — can be imported in a single action.
// Each bundle has exactly one model file, which keeps the engine's single-model loader path valid.

// Formats the engine can actually load into a Model (GLTF via GLTFLoader, the rest via Assimp).
export const MODEL_EXTS = ['.gltf', '.glb', '.obj', '.fbx']
// Aux files that belong to a specific model (not shared across sibling models in the same folder).
const COMPANION_EXTS = ['.mtl', '.bin']

export type ImportBundle = { name: string; files: File[] }

function relPathOf(file: File): string {
  return file.webkitRelativePath || (file as any).relativePath || file.name
}
function normalize(path: string): string { return path.replace(/\\/g, '/') }
function baseName(path: string): string { const p = normalize(path); return p.slice(p.lastIndexOf('/') + 1) }
function dirOf(path: string): string { const p = normalize(path); const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : '' }
function extOf(name: string): string { const b = baseName(name).toLowerCase(); const i = b.lastIndexOf('.'); return i >= 0 ? b.slice(i) : '' }
function stemOf(name: string): string { const b = baseName(name); const i = b.lastIndexOf('.'); return i >= 0 ? b.slice(0, i) : b }

export function isModelFile(file: File): boolean {
  return MODEL_EXTS.includes(extOf(file.name))
}

/**
 * Group a flat file list into per-model bundles. Each model file (.gltf/.glb/.obj/.fbx) seeds a bundle
 * and collects the aux files (buffers/textures/mtl) that belong to it. When several models share a
 * folder, companion files (.mtl/.bin) are matched to the model of the same basename; shared textures
 * still attach to every model. Loose (folderless) selections attach all aux.
 *
 * "Belongs to it" is deliberately generous, because the alternative fails silently: an aux file that no
 * bundle claims is registered as a loose texture by runUpload and never reaches the material, so the
 * model imports untextured with the images sitting in the explorer and nothing said about it. So:
 *  - one model in the whole selection → it claims everything (there is nothing else it could belong to);
 *  - otherwise its own folder and anything nested under it, PLUS sibling folders of it — the extremely
 *    common `Character/model/char.fbx` + `Character/textures/char_D.png` layout, which a strict
 *    "at or below the model's folder" test rejects.
 */
export function groupImportFiles(files: File[]): ImportBundle[] {
  const infos = files.map(f => {
    const path = relPathOf(f)
    return { file: f, dir: dirOf(path), ext: extOf(path), stem: stemOf(path) }
  })

  const models = infos.filter(i => MODEL_EXTS.includes(i.ext))
  const aux = infos.filter(i => !MODEL_EXTS.includes(i.ext))
  if (models.length === 0) return []

  // How many model files sit directly in a given directory (drives companion-file disambiguation).
  const modelsPerDir = new Map<string, number>()
  for (const m of models) modelsPerDir.set(m.dir, (modelsPerDir.get(m.dir) ?? 0) + 1)

  const soleModel = models.length === 1

  return models.map(m => {
    // Only a model at least two levels deep has a parent worth looking sideways from: at depth 1 the
    // parent is the selection root, and `rock/rock.fbx` would swallow `tree/`'s textures. Over-claiming
    // is not free — an image a bundle claims but no material uses is never registered at all.
    const parent = dirOf(m.dir)
    const bundleFiles: File[] = [m.file]
    for (const a of aux) {
      const under = m.dir === '' || a.dir === m.dir || a.dir.startsWith(m.dir + '/')
      const sibling = parent !== '' && (a.dir === parent || a.dir.startsWith(parent + '/'))
      if (!soleModel && !under && !sibling) continue
      // A companion in a folder with multiple models belongs only to the matching-named model.
      const isCompanion = COMPANION_EXTS.includes(a.ext)
      if (isCompanion && (modelsPerDir.get(a.dir) ?? 0) > 1 && a.stem !== m.stem) continue
      bundleFiles.push(a.file)
    }
    return { name: m.stem, files: bundleFiles }
  })
}

/**
 * Flatten a drop's files AND folders into a File[]. Uses the webkitGetAsEntry API to recurse dropped
 * directories; each file is tagged with a synthesized `relativePath` so groupImportFiles can see its
 * folder. Falls back to the plain DataTransfer file list when the entry API is unavailable.
 */
export async function readDroppedEntries(dt: DataTransfer): Promise<File[]> {
  const roots: any[] = []
  const plainFiles: File[] = []
  const items = dt.items
  if (items && items.length) {
    // webkitGetAsEntry must be read synchronously — the DataTransferItemList empties after an await.
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (it.kind !== 'file') continue
      const entry = (it as any).webkitGetAsEntry?.()
      if (entry) roots.push(entry)
      else { const f = it.getAsFile(); if (f) plainFiles.push(f) }
    }
  }
  if (roots.length === 0) {
    const flat = dt.files ? Array.from(dt.files) : []
    return [...plainFiles, ...flat]
  }
  const out: File[] = [...plainFiles]
  for (const entry of roots) await walkEntry(entry, out)
  return out
}

async function walkEntry(entry: any, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => entry.file(res, rej))
    ;(file as any).relativePath = (entry.fullPath as string | undefined)?.replace(/^\//, '') || file.name
    out.push(file)
  } else if (entry.isDirectory) {
    const reader = entry.createReader()
    let batch: any[]
    // readEntries yields in batches; keep reading until it returns an empty batch.
    do {
      batch = await new Promise<any[]>((res, rej) => reader.readEntries(res, rej))
      for (const e of batch) await walkEntry(e, out)
    } while (batch.length > 0)
  }
}
