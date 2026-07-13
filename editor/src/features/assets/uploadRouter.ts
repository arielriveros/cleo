import { TextureManager } from 'cleo'
import { groupImportFiles, isModelFile } from '../../utils/importGrouping'

// Routes a batch of OS files dropped on (or picked from) the asset explorer to the right ingestion path.
// This replaces the two separate uploaders the old Textures and Meshes tabs each had.
//
// We deliberately do NOT use SVAR's built-in <Uploader>: it walks dropped directories with
// entry.createReader() but never records the resulting relative path on the File, so a .gltf + .bin +
// textures/ folder arrives as a flat, unrelated pile. groupImportFiles needs those paths to work out which
// buffer and which texture belong to which model.

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.tga', '.webp', '.tiff', '.gif']

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i).toLowerCase()
}

export function isImageFile(file: File): boolean {
  return IMAGE_EXTS.includes(extOf(file.name))
}

/** Register one image file as a texture, keyed by its filename (as the old Textures tab did). */
function addTexture(file: File): Promise<void> {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = ev => {
      const data = ev.target?.result as string | undefined
      if (data) TextureManager.Instance.addTextureFromBase64(data, { wrapping: 'repeat' }, file.name)
      resolve()
    }
    reader.onerror = () => { console.warn('Failed to read texture file:', file.name); resolve() }
    reader.readAsDataURL(file)
  })
}

export type UploadDeps = {
  importMeshFiles: (files: File[]) => Promise<void>
  emit: (event: string) => void
}

/**
 * Ingest a mixed batch of files.
 *
 * When the batch contains any model file the WHOLE batch goes to importMeshFiles — it runs groupImportFiles
 * itself, which is what decides that `rock.bin` belongs to `rock.gltf` and not to `tree.gltf`. Pre-splitting
 * here would throw that disambiguation away. Images that no bundle claimed (plus batches with no model at
 * all) are registered as standalone textures.
 */
export async function runUpload(files: File[], deps: UploadDeps): Promise<void> {
  if (!files.length) return

  const hasModel = files.some(isModelFile)
  if (!hasModel) {
    const images = files.filter(isImageFile)
    if (!images.length) return
    await Promise.all(images.map(addTexture))
    deps.emit('TEXTURES_CHANGED')
    return
  }

  // Which files the mesh importer will consume — everything else that's an image becomes a loose texture.
  const claimed = new Set<File>()
  for (const bundle of groupImportFiles(files)) for (const f of bundle.files) claimed.add(f)

  const loose = files.filter(f => !claimed.has(f) && isImageFile(f))
  if (loose.length) {
    await Promise.all(loose.map(addTexture))
    deps.emit('TEXTURES_CHANGED')
  }

  await deps.importMeshFiles(files)
}
