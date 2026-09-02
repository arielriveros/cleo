import { cryptoRandomId } from './ids'

// A raw image asset: the decoded-once pixel source a texture is built FROM, and nothing about how it is
// sampled. Splitting it out of the texture is what lets one `rock.png` be a repeating tiled surface in
// one material and a clamped decal in another — the wrap mode belongs to the texture, not to the bytes.
//
// THE BYTES ARE NOT IN THIS RECORD. They stay exactly where they have always been: a Blob in the
// `TEXTURE_STORE` IndexedDB object store, keyed `p:<project>:<imageId>` (see textureStore.ts). This
// record is the metadata sidecar, small enough to live in the `kv` library array that `usePersistedLibrary`
// rewrites whole on every edit.
//
// AN IMAGE ID IS A TEXTURE ID. For everything that existed before the image/texture split, `ImageAsset.id`
// IS the TextureManager id its bytes were first registered under — which is why the split moves no bytes
// and re-keys no rows: an existing store key is simply read as an image id from now on. The two are
// separate namespaces (`assetKey(kind, assetId)` in vfs.ts keys by kind, and the VFS paths differ by
// extension), so an image and a texture sharing a string is unambiguous, not a collision.

export type ImageAsset = {
  /** Also the `TEXTURE_STORE` key suffix holding the bytes. Immutable — `name` is the display name. */
  id: string
  /**
   * Display name. Freely renameable, unlike a texture id: nothing serialized references an image, only
   * `TextureAsset.source.imageId` does, and that is internal to the editor.
   */
  name: string
  mime: string
  /**
   * Pixel dimensions, or 0 when not yet known. Decoding every image at boot to fill these in would cost
   * a full decode of a project's entire library for two numbers, so they are backfilled lazily as each
   * image is decoded for its texture (see textureReady.ts, which exists because that decode is async
   * with no callback).
   */
  width: number
  height: number
  /** Compressed byte length. Exact, unlike the base64-length estimate the explorer used to show. */
  byteSize: number
  /**
   * How these bytes came to exist. Not decoration: a 'baked' image is regenerable from its texture's
   * PackSpec, so a repair pass may rebuild one rather than report it permanently missing.
   */
  origin: ImageOrigin
  created: number
}

export type ImageOrigin =
  /** Dropped on the explorer, or picked through Import Files. */
  | 'upload'
  /** Arrived inside a model import (.gltf/.glb/.fbx/.obj) or an atlas import. */
  | 'import'
  /** Composited by the editor from a texture's channel-pack spec. */
  | 'baked'
  /** Produced from another image by the engine — an LOD downscale, say. */
  | 'derived'

export function buildImageAsset(
  init: Partial<ImageAsset> & Pick<ImageAsset, 'mime'>,
): ImageAsset {
  return {
    id: init.id ?? cryptoRandomId(),
    name: init.name ?? 'Image',
    mime: init.mime,
    width: init.width ?? 0,
    height: init.height ?? 0,
    byteSize: init.byteSize ?? 0,
    origin: init.origin ?? 'upload',
    created: init.created ?? Date.now(),
  }
}

/**
 * Fill in dimensions once an image has actually decoded. Returns the same array when nothing changed, so
 * a caller can use it as the React state updater directly without forcing a render on every poll.
 */
export function withImageSize(
  images: ImageAsset[], id: string, width: number, height: number,
): ImageAsset[] {
  if (!width || !height) return images
  const i = images.findIndex(img => img.id === id)
  if (i < 0) return images
  const image = images[i]
  if (image.width === width && image.height === height) return images
  const next = images.slice()
  next[i] = { ...image, width, height }
  return next
}
