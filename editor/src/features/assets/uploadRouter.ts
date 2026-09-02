import { TextureManager } from 'cleo'
import { groupImportFiles, isModelFile } from '../../utils/importGrouping'

// Routes a batch of OS files dropped on (or picked from) the asset explorer to the right ingestion path.
// SVAR's built-in <Uploader> is not used: it never records a dropped file's relative path, and
// groupImportFiles needs those paths to pair a .bin and a textures/ folder with the right .gltf.

export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.tga', '.webp', '.tiff', '.gif']

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i).toLowerCase()
}

export function isImageFile(file: File): boolean {
  return IMAGE_EXTS.includes(extOf(file.name))
}

/**
 * Register one image file as a texture, keyed by its filename.
 *
 * The Image and Texture ASSET records are not minted here. `reconcileTextureAssets` derives both from
 * what ends up registered in the TextureManager, so every ingestion path — this one, the model importer,
 * the atlas importer, a scene parse — gets them for free instead of each remembering to create a pair.
 *
 * `addTextureFromFile` rather than a FileReader data URL: it reads the ArrayBuffer directly and retains
 * the compressed bytes, which is what lets the texture be persisted at all. Routing megabytes of image
 * through base64 was pure overhead.
 */
function addTexture(file: File): void {
  TextureManager.Instance.addTextureFromFile(file, { wrapping: 'repeat' }, file.name)
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
    images.forEach(addTexture)
    deps.emit('TEXTURES_CHANGED')
    return
  }

  // Files the mesh importer will consume; every other image becomes a loose texture.
  const claimed = new Set<File>()
  for (const bundle of groupImportFiles(files)) for (const f of bundle.files) claimed.add(f)

  const loose = files.filter(f => !claimed.has(f) && isImageFile(f))
  if (loose.length) {
    loose.forEach(addTexture)
    deps.emit('TEXTURES_CHANGED')
  }

  await deps.importModelFiles(files)

  // ...and then every CLAIMED image the import did not end up registering itself.
  //
  // A bundle claims an image so the mesh importer can RESOLVE it, not so it can be swallowed. Several
  // routes drop maps the file plainly references: an .fbx goes through assimp's glTF2 converter, whose
  // exporter emits only baseColorTexture (the normal map arrives as aiTextureType_HEIGHT, which it does
  // not look for, and AO/roughness go the same way), and glTF has no height channel at all. Those files
  // then exist in NEITHER the material nor the texture library, and the only way to assign one is to
  // upload it again with the model deselected. groupImportFiles' own doc comment calls this out as the
  // silent failure over-claiming causes.
  //
  // After the import, not before, and keyed by FILENAME — `uniqueTextureId` hands back the bare name
  // when it is free, so anything the loader already registered is skipped here rather than duplicated
  // under a "name (2)" alias that no material points at.
  const unregistered = files.filter(f =>
    claimed.has(f) && isImageFile(f) && !TextureManager.Instance.textures.has(f.name))
  if (unregistered.length) {
    unregistered.forEach(addTexture)
    deps.emit('TEXTURES_CHANGED')
  }
}
