import type { TextureConfig, PackSpec } from 'cleo'
import type { ImageAsset } from './images'

// A Texture asset: a byte SOURCE plus every decision about how the GPU samples it. The other half of the
// image/texture split — see images.ts for the bytes.
//
// `TextureAsset.id` IS the TextureManager id, unchanged and never renamed. That id is baked into every
// serialized material, scene, template, tileset, foliage rule and UI node, so the split deliberately
// leaves it alone: nothing is remapped, and a project saved before any of this still resolves. The `name`
// field is new and free, which is what finally makes a texture renameable.

/** Where a texture's pixels come from. */
export type TextureSource =
  /** An ImageAsset. The ordinary case. */
  | { kind: 'image'; imageId: string }
  /**
   * Four channels gathered from other textures, composited by the editor to a real ImageAsset at save
   * time. `spec` is kept so the pack stays re-editable; `bakedImageId` is the result.
   */
  | { kind: 'pack'; spec: PackSpec; bakedImageId?: string }
  /**
   * The bytes belong to something the editor does not own, and there is nothing to re-source: a built-in,
   * an engine data texture, or an `addTextureFromPath` load — which is how a glTF's externally-referenced
   * images arrive (gltfLoader) and why `persistTextures` documents skipping them. The sampling settings
   * are still authorable. Only ever minted by the reconciler, never by the UI.
   */
  | { kind: 'runtime' }

export type WrapMode = 'clamp' | 'repeat' | 'mirror'
export type FilterMode = 'nearest' | 'linear'

/**
 * Everything a user decides about a texture. An authoring-shaped superset of the engine's
 * {@link TextureConfig}, compiled down by {@link toTextureConfig}.
 *
 * Every field is required, unlike `TextureConfig` — an optional field here would be one the inspector
 * has no value to show. It deliberately cannot express `usage`, `target`, `size`, `storage` or
 * `channels`: those change how a texture is ALLOCATED, they belong to the engine subsystem that created
 * it, and a user has no business setting them on an image.
 */
export type TextureSettings = {
  wrapU: WrapMode
  wrapV: WrapMode
  /** The third axis of a 3D volume. Authored for completeness; ignored by 2D and cube targets. */
  wrapW: WrapMode
  /** Minification within a level. */
  minFilter: FilterMode
  /** Magnification. `nearest` is what keeps pixel art sharp when zoomed in. */
  magFilter: FilterMode
  /** Build a mip chain at all. */
  mipMap: boolean
  /** The filter BETWEEN levels. Ignored when `mipMap` is false. */
  mipMapFilter: FilterMode
  /**
   * Samples along the axis of anisotropy; 1 is off. Stored UNCLAMPED — the device limit belongs to the
   * machine, not to the asset, so a project authored at 16x must not be flattened to 4x by opening it
   * once on a weaker GPU. `resolveSampler` clamps at bind time.
   */
  anisotropy: number
  /** The mip range the sampler may read. Undefined means the whole chain. */
  lodMin?: number
  lodMax?: number
  /**
   * TRUE means the image is flipped vertically on upload, which is what every existing texture does.
   *
   * POSITIVE POLARITY, unlike `TextureConfig.flipY`, which means the opposite of its name for
   * compatibility reasons its own doc comment explains. {@link toTextureConfig} is the one place in the
   * codebase that inverts, so the checkbox in the inspector can read the way it is labelled.
   */
  flipY: boolean
  precision: 'low' | 'high'
  /**
   * Authoring intent. Does NOT select an sRGB hardware format: the shaders decode colour with an
   * unconditional `pow(rgb, 2.2)` in ten chunks, so an sRGB format would decode a second time and take
   * albedo to roughly `pow(x, 4.84)`. Used for the viewer's display transform and to warn when a texture
   * marked `srgb` is assigned to a data slot like `normalMap`. See the plan's section 4.
   */
  colorSpace: 'srgb' | 'linear'
}

export type TextureAsset = {
  /** THE TextureManager id. Immutable and baked into every serialized reference. */
  id: string
  /** Display name, decoupled from the id — this is what the VFS path tracks and what renaming edits. */
  name: string
  /** Record schema version. Bumped only when an existing setting changes MEANING. */
  version: 1
  source: TextureSource
  settings: TextureSettings
  thumbnail?: string
  /**
   * Duplicated from `id` plus any pack sources. `referencedTextureIds` (textureStore.ts) and the bundle
   * walkers find ids by FIELD NAME rather than by understanding each schema, so an asset that wants to
   * be found has to carry one. Exactly the trick `TilesetAsset.textureIds` uses.
   */
  textureIds: string[]
  /** The image half, for the same reason. Empty for a `runtime` source. */
  imageIds: string[]
}

/** Today's behaviour, exactly: what every hardcoded `{ wrapping: 'repeat' }` call site was asking for. */
export const DEFAULT_TEXTURE_SETTINGS: TextureSettings = {
  wrapU: 'repeat', wrapV: 'repeat', wrapW: 'repeat',
  minFilter: 'linear', magFilter: 'linear',
  mipMap: true, mipMapFilter: 'linear',
  anisotropy: 1,
  // `TextureConfig.flipY` defaults to false, and false MEANS flipped. So the positive spelling is true.
  flipY: true,
  precision: 'low',
  colorSpace: 'srgb',
}

/** The ids a texture's source depends on, for `imageIds`. */
function imageIdsOf(source: TextureSource): string[] {
  if (source.kind === 'image') return [source.imageId]
  if (source.kind === 'pack') return source.bakedImageId ? [source.bakedImageId] : []
  return []
}

/** The texture ids a pack reads its channels from — they must survive a bundle that ships the pack. */
function packSourceIds(source: TextureSource): string[] {
  if (source.kind !== 'pack') return []
  const ids = new Set<string>()
  for (const channel of [source.spec.r, source.spec.g, source.spec.b, source.spec.a])
    if (channel && 'textureId' in channel && channel.textureId) ids.add(channel.textureId)
  return [...ids]
}

export function buildTextureAsset(
  id: string,
  name: string,
  source: TextureSource,
  settings: Partial<TextureSettings> = {},
): TextureAsset {
  const merged = { ...DEFAULT_TEXTURE_SETTINGS, ...settings }
  return {
    id,
    name,
    version: 1,
    source,
    settings: merged,
    textureIds: [id, ...packSourceIds(source)],
    imageIds: imageIdsOf(source),
  }
}

/**
 * Re-derive the duplicated id lists after `source` changes. Call this instead of editing `source` in
 * place, or the reference walkers keep reporting the old dependencies and a bundle ships the wrong bytes.
 */
export function withSource(asset: TextureAsset, source: TextureSource): TextureAsset {
  return {
    ...asset,
    source,
    textureIds: [asset.id, ...packSourceIds(source)],
    imageIds: imageIdsOf(source),
  }
}

/**
 * Compile authored settings into the engine config a `Texture` is built from.
 *
 * THIS IS THE ONE PLACE `flipY` INVERTS. `TextureConfig.flipY === false` means "flipped", a polarity
 * baked into every project ever saved and therefore uncorrectable in place; `TextureSettings.flipY` is
 * positive. Everything downstream of here — the RHI descriptor, both backends — reads truthfully.
 */
export function toTextureConfig(settings: TextureSettings): TextureConfig {
  return {
    flipY: !settings.flipY,
    // `wrapping` is emitted alongside the per-axis fields so a reader older than they are (an exported
    // bundle opened by a previous build, a published pack) still gets the U axis rather than the default.
    wrapping: settings.wrapU,
    wrapU: settings.wrapU,
    wrapV: settings.wrapV,
    wrapW: settings.wrapW,
    minFilter: settings.minFilter,
    magFilter: settings.magFilter,
    mipMap: settings.mipMap,
    mipMapFilter: settings.mipMapFilter,
    anisotropy: settings.anisotropy,
    ...(settings.lodMin !== undefined ? { lodMin: settings.lodMin } : {}),
    ...(settings.lodMax !== undefined ? { lodMax: settings.lodMax } : {}),
    precision: settings.precision,
  }
}

/**
 * Read authored settings back out of a stored engine config.
 *
 * Tolerant by design: this is the whole of the data migration. It is handed configs written by every
 * version that ever ran — a `{ wrapping: 'repeat' }` literal from an import path, a full round-tripped
 * `Texture.config`, a legacy bundle row, `undefined` — and must produce today's behaviour for all of
 * them. Absent means "whatever the engine did before the field existed", NOT the authoring default,
 * which is why this cannot simply spread over DEFAULT_TEXTURE_SETTINGS.
 */
export function fromTextureConfig(config: unknown): TextureSettings {
  const c = (config ?? {}) as Partial<TextureConfig>
  const wrap = (v: unknown, fallback: WrapMode): WrapMode =>
    v === 'clamp' || v === 'repeat' || v === 'mirror' ? v : fallback
  const filter = (v: unknown, fallback: FilterMode): FilterMode =>
    v === 'nearest' || v === 'linear' ? v : fallback

  // The engine's own default is 'clamp' when `wrapping` is absent — NOT the 'repeat' that every editor
  // import path passes explicitly. A config with no wrapping really was clamped, so it stays clamped.
  const both = wrap(c.wrapping, 'clamp')
  // Absent mipMap meant TRUE in the Texture constructor. An import that passed `mipMap: false` (which is
  // what the glTF route does, and why imported models have no mipmaps) has to survive as false.
  const mipMap = c.mipMap === undefined ? true : !!c.mipMap
  const mipMapFilter = filter(c.mipMapFilter, 'linear')

  return {
    wrapU: wrap(c.wrapU, both),
    wrapV: wrap(c.wrapV, both),
    wrapW: wrap(c.wrapW, both),
    // Minification used to be forced to the mip filter — they only became independent with the sampler
    // work, so a config predating that must keep reading as the fused value.
    minFilter: filter(c.minFilter, mipMapFilter),
    magFilter: filter(c.magFilter, 'linear'),
    mipMap,
    mipMapFilter,
    anisotropy: typeof c.anisotropy === 'number' && c.anisotropy >= 1 ? Math.round(c.anisotropy) : 1,
    ...(typeof c.lodMin === 'number' ? { lodMin: c.lodMin } : {}),
    ...(typeof c.lodMax === 'number' ? { lodMax: c.lodMax } : {}),
    // The inversion, read back. `flipY: false` (or absent) meant flipped.
    flipY: !c.flipY,
    precision: c.precision === 'high' ? 'high' : 'low',
    // Never stored by any config the engine writes — it is an editor concept. Colour is the safe guess:
    // it is what the shaders already assume for every map they decode.
    colorSpace: 'srgb',
  }
}

// ---------------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------------

/** What the reconciler needs to know about one live texture. Keeps it free of the TextureManager. */
export type LiveTexture = {
  id: string
  config: unknown
  width: number
  height: number
  /** The compressed bytes the texture retained, or null for a built-in or path-loaded one. */
  source: { mime: string; byteLength: number } | null
}

/**
 * Bring the Image and Texture libraries in line with what is actually registered in the TextureManager.
 *
 * THIS IS THE MIGRATION, and it is a continuous reconciler rather than a one-shot versioned pass on
 * purpose. It mints a record only for a live texture id that has none, so it is idempotent by
 * construction — and the same code therefore covers the first boot after the upgrade, a model import, an
 * atlas import, a scene parse, a bundle import and an asset-pack import, instead of six call-site edits
 * and a marker key that a bundle written by an older build would slip past.
 *
 * A texture that retained its bytes gets an ImageAsset under THE SAME ID (see images.ts on why that moves
 * no bytes) and an image-sourced TextureAsset. One with no retained bytes gets a `runtime` texture and no
 * image.
 *
 * Returns the same arrays when nothing changed, so the caller can assign the result unconditionally
 * without causing a render.
 */
export function reconcileTextureAssets(
  live: LiveTexture[],
  images: ImageAsset[],
  textures: TextureAsset[],
): { images: ImageAsset[]; textures: TextureAsset[]; changed: boolean } {
  const haveImage = new Set(images.map(i => i.id))
  const haveTexture = new Set(textures.map(t => t.id))

  const newImages: ImageAsset[] = []
  const newTextures: TextureAsset[] = []

  for (const t of live) {
    if (!t.id || haveTexture.has(t.id)) continue

    const bytes = t.source
    if (bytes && !haveImage.has(t.id)) {
      haveImage.add(t.id)
      newImages.push({
        id: t.id,
        name: t.id,
        mime: bytes.mime,
        width: t.width,
        height: t.height,
        byteSize: bytes.byteLength,
        origin: 'import',
        created: Date.now(),
      })
    }

    haveTexture.add(t.id)
    newTextures.push(buildTextureAsset(
      t.id,
      // A texture id is a filename on every path that mints one, so the stem is the readable half. The
      // id itself keeps the extension, because it is what materials reference.
      stemOf(t.id),
      // `haveImage` already covers the row just minted above, and also an image a previous pass created
      // for a texture whose bytes have since been released.
      haveImage.has(t.id) ? { kind: 'image', imageId: t.id } : { kind: 'runtime' },
      fromTextureConfig(t.config),
    ))
  }

  if (!newImages.length && !newTextures.length)
    return { images, textures, changed: false }

  return {
    images: newImages.length ? [...images, ...newImages] : images,
    textures: [...textures, ...newTextures],
    changed: true,
  }
}

/** 'rock_albedo.png' -> 'rock_albedo'. Left alone when there is no extension to trim. */
function stemOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? name : name.slice(0, i)
}

/**
 * Backfill dimensions the reconciler could not know, once an image has decoded. Separate from the
 * reconciler because it runs against images that already exist, and it must not mint anything.
 */
export function imageIdsMissingSize(images: ImageAsset[]): string[] {
  return images.filter(i => !i.width || !i.height).map(i => i.id)
}
