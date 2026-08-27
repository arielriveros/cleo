import { TextureManager } from 'cleo'
import { groupImportFiles, isModelFile } from '../../utils/importGrouping'

// Routes a batch of OS files dropped on (or picked from) the asset explorer to the right ingestion path.
// SVAR's built-in <Uploader> is not used: it never records a dropped file's relative path, and
// groupImportFiles needs those paths to pair a .bin and a textures/ folder with the right .gltf.

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.tga', '.webp', '.tiff', '.gif']

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i).toLowerCase()
}

export function isImageFile(file: File): boolean {
  return IMAGE_EXTS.includes(extOf(file.name))
}

/** Register one image file as a texture, keyed by its filename. */
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
  importModelFiles: (files: File[]) => Promise<void>
  emit: (event: string) => void
}

/**
 * Ingest a mixed batch of files.
 * A batch containing any model file goes to importModelFiles whole: it runs groupImportFiles itself, which
 * decides that `rock.bin` belongs to `rock.gltf` and not to `tree.gltf`. Unclaimed images become textures.
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

  // Files the mesh importer will consume; every other image becomes a loose texture.
  const claimed = new Set<File>()
  for (const bundle of groupImportFiles(files)) for (const f of bundle.files) claimed.add(f)

  const loose = files.filter(f => !claimed.has(f) && isImageFile(f))
  if (loose.length) {
    await Promise.all(loose.map(addTexture))
    deps.emit('TEXTURES_CHANGED')
  }

  await deps.importModelFiles(files)
}
