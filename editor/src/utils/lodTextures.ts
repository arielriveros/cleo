import { TextureManager } from 'cleo'
import { awaitTextureImage } from './textureReady'
import { persistTextures } from './textureStore'
import { parseBase64DataUri } from './bytes'
import { deepClone } from './deepClone'
import { cryptoRandomId } from './ids'
import type { MaterialAsset } from './materials'

// Half-resolution copies of a model's textures, for its generated LOD levels.
//
// Textures are stored as their ORIGINAL COMPRESSED BYTES, not as pixels, so "downscale" here means
// re-encode: draw the decoded image into a smaller canvas and register the resulting PNG as a new
// texture. Canvas 2D is the right tool — the browser has already decoded the image and there is nothing
// to pose or light — and `tilesetThumbnail.ts` is the same primitive at card size.

/** Never go below this on either axis; past it a normal or mask map stops describing anything. */
export const MIN_LOD_TEXTURE_SIZE = 64

/**
 * Derived id for a source texture at a target width.
 *
 * Deterministic on purpose, and it is what makes both requirements work: two levels that land on the
 * same size SHARE one image, and regenerating a model's LODs reuses the ids it minted last time instead
 * of leaking a new set each press. Not the `__packed__` prefix — those are treated as derived-and-
 * disposable and are excluded from persistence and publish, while these must survive a reload.
 */
export function lodTextureId(sourceId: string, width: number): string {
    return `${sourceId}__lod${width}`
}

/**
 * True for a LOD level's downscaled twin. Those belong to the model whose generated levels draw them —
 * stored, shipped and preloaded like any texture, but never an asset of their own: the explorer hides
 * them and deleting the model deletes them.
 */
export function isLodTextureId(id: string | null | undefined): boolean {
    return !!id && /__lod\d+$/.test(id)
}

/** Half of `n`, floored at {@link MIN_LOD_TEXTURE_SIZE}; stays power-of-two when the source was. */
export function halveTo(n: number, level: number): number {
    let out = n
    for (let i = 0; i < level; i++) out = Math.max(1, out >> 1)
    return Math.max(Math.min(n, MIN_LOD_TEXTURE_SIZE), out)
}

/**
 * True when any pixel of `image` is not fully opaque.
 *
 * Canvas 2D composites in PREMULTIPLIED alpha, so a re-encode zeroes RGB wherever alpha is 0. For an
 * alpha-CUTOUT albedo that is the correct filter — transparent texels should contribute no colour rather
 * than dragging the result toward black — but for a map whose alpha carries DATA (a packed ORM with
 * occlusion in alpha) it destroys a channel. Callers use this to leave those alone instead.
 */
function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
    const { data } = ctx.getImageData(0, 0, w, h)
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true
    return false
}

export interface DownscaleResult {
    /** Source id -> derived id. A source left at full size maps to itself. */
    ids: Map<string, string>
    /** Ids actually minted this call, for persistTextures. */
    minted: string[]
    /** Approximate bytes saved, level 0 only (a quarter-area copy is a quarter of the texels). */
    bytesSaved: number
}

/**
 * Half-resolution twins of `sourceIds`, `level` halvings deep.
 *
 * Idempotent: an id that already exists is reused rather than re-encoded, which is what lets two levels
 * at the same size share one image and lets regeneration be cheap.
 */
export async function downscaleTextures(sourceIds: Iterable<string>, level: number): Promise<DownscaleResult> {
    const tm = TextureManager.Instance
    const ids = new Map<string, string>()
    const minted: string[] = []
    let bytesSaved = 0

    for (const sourceId of new Set(sourceIds)) {
        if (!sourceId) continue
        ids.set(sourceId, sourceId) // fall back to the source unless everything below succeeds

        // The decode has to have landed: naturalWidth is 0 until it does, and a texture whose image has
        // not loaded is silently dropped from serialization.
        const image = await awaitTextureImage(sourceId)
        if (!image || !image.naturalWidth || !image.naturalHeight) continue

        const width = halveTo(image.naturalWidth, level)
        const height = halveTo(image.naturalHeight, level)
        if (width >= image.naturalWidth && height >= image.naturalHeight) continue // already at the floor

        const derivedId = lodTextureId(sourceId, width)
        if (tm.getTexture(derivedId)) { ids.set(sourceId, derivedId); continue }

        try {
            const source = tm.getTexture(sourceId)
            const full = document.createElement('canvas')
            full.width = image.naturalWidth
            full.height = image.naturalHeight
            const fullCtx = full.getContext('2d', { willReadFrequently: true })
            if (!fullCtx) continue
            fullCtx.drawImage(image, 0, 0)
            // Skip a map whose alpha is data rather than coverage — see hasTransparency.
            if (hasTransparency(fullCtx, full.width, full.height) && isDataMap(sourceId)) continue

            const canvas = document.createElement('canvas')
            canvas.width = width
            canvas.height = height
            const ctx = canvas.getContext('2d')
            if (!ctx) continue
            ctx.imageSmoothingEnabled = true
            ctx.imageSmoothingQuality = 'high'
            ctx.drawImage(image, 0, 0, width, height)

            const uri = canvas.toDataURL('image/png')
            const parsed = parseBase64DataUri(uri)
            if (!parsed || parsed.bytes.length === 0) continue

            const derived = new Image()
            derived.src = uri
            await derived.decode().catch(() => undefined)

            // The 4th argument is load-bearing: without the source bytes the texture renders this session
            // and is gone on reload, because persistTextures skips anything with no retained source.
            // The source's own config comes along too — `wrapping` especially, or tiling breaks.
            tm.addTextureFromData(derived, source?.config, derivedId, { bytes: parsed.bytes, mime: parsed.mime })
            ids.set(sourceId, derivedId)
            minted.push(derivedId)
            const before = image.naturalWidth * image.naturalHeight * 4
            bytesSaved += before - width * height * 4
        } catch {
            // A cross-origin image taints the canvas and toDataURL throws; keep the full-size texture.
        }
    }

    if (minted.length) await persistTextures(minted)
    return { ids, minted, bytesSaved }
}

/**
 * Whether a texture id looks like a map whose ALPHA carries data rather than coverage.
 *
 * Deliberately a name heuristic and deliberately conservative: the only cost of a false positive is that
 * one map stays full-size, while a false negative silently corrupts a channel. Slot names are not
 * available here — a texture id is shared by every material that references it.
 */
function isDataMap(id: string): boolean {
    return /orm|occlusion|metallic|roughness|mask|packed|arm\b/i.test(id)
}

/**
 * A copy of `asset` whose every texture slot points at the derived twin in `ids`.
 *
 * A generated level needs its OWN MaterialAsset: at instantiation `resolveMaterialRefs` overwrites a
 * subtree's embedded material from the library via `__materialId`, so repointing the embedded copy alone
 * would be discarded and the level would draw at full texture resolution.
 *
 * The walk is generic rather than a per-type slot list because the SERIALIZED slot names differ from the
 * runtime map keys for `basic` and `blinn_phong` (`base` vs `baseTexture`, `mask` vs `maskMap`), and a
 * hand-maintained list would drift.
 */
export function materialAssetWithTextures(asset: MaterialAsset, ids: Map<string, string>, name: string): MaterialAsset {
    const material = deepClone(asset.material)
    const textureIds: string[] = []
    const textures = material?.textures
    if (textures && typeof textures === 'object')
        for (const slot of Object.keys(textures)) {
            const current = textures[slot]
            if (typeof current !== 'string' || !current) continue
            const next = ids.get(current) ?? current
            textures[slot] = next
            if (!textureIds.includes(next)) textureIds.push(next)
        }
    // Built literally rather than through buildMaterialAsset: that takes a live `Material` and re-runs
    // serialize(), and what needs preserving here is the ALREADY-serialized shape with its slots
    // repointed. `textureIds` is recollected from the repointed map, never copied from the source.
    return { id: cryptoRandomId(), name, material, textureIds, thumbnail: asset.thumbnail }
}


/**
 * Serialized texture slots a level FROM 2 ON still draws: the colour, the normal map, and the alpha mask.
 *
 * The rest — metallic/roughness/occlusion, emissive, specular, reflectivity, ramp, displacement — is
 * detail nobody resolves at that distance, and each one is a texture fetch and a texture upload. The mask
 * stays because it is not detail: a leaf card without its cutout draws as a solid quad.
 * Keys are the SERIALIZED names (`Material.serialize`), which differ per shading model.
 */
export const DISTANT_LOD_SLOTS: ReadonlySet<string> = new Set([
    'texture', 'baseColorTexture', 'base',   // basic / pbr / blinn_phong + cel colour
    'normalMap', 'normal',                    // pbr / blinn_phong + cel normal
    'mask',                                   // alpha cutout, every model
])

/** The texture ids a level keeps from one serialized material — every slot at level 1, fewer beyond it. */
export function levelTextureIds(serialized: any, level: number): string[] {
    const out: string[] = []
    const textures = serialized?.textures
    if (!textures || typeof textures !== 'object') return out
    for (const [slot, id] of Object.entries(textures))
        if (typeof id === 'string' && id && (level < 2 || DISTANT_LOD_SLOTS.has(slot)) && !out.includes(id)) out.push(id)
    return out
}

/**
 * A level's INLINE copy of a serialized material: every kept slot repointed at its downscaled twin in `ids`,
 * and — from level 2 on — every slot outside {@link DISTANT_LOD_SLOTS} removed. Scalar properties are left
 * alone, so a dropped roughness map falls back to the material's own roughness value, not to a default.
 */
export function levelMaterialJson(serialized: any, ids: Map<string, string>, level: number): any {
    const material = deepClone(serialized)
    const textures = material?.textures
    if (textures && typeof textures === 'object')
        for (const slot of Object.keys(textures)) {
            const current = textures[slot]
            if (typeof current !== 'string' || !current) continue
            if (level >= 2 && !DISTANT_LOD_SLOTS.has(slot)) { delete textures[slot]; continue }
            textures[slot] = ids.get(current) ?? current
        }
    return material
}

/** The full-resolution texture a (possibly chained) LOD twin id was made from. */
export function lodSourceTextureId(id: string): string {
    return id.replace(/(__lod\d+)+$/, '')
}

/**
 * The texture LOD `level` draws in place of `sourceId`: its registered twin at `level` halvings, or the
 * source itself when no twin exists (never made, or the source is already at the size floor). Falling
 * back to full size is the safe direction — a missing twin must never draw as an untextured white model.
 */
export function lodTwinFor(sourceId: string, level: number): string {
    const tm = TextureManager.Instance
    const source = tm.getTexture(sourceId) as { width?: number } | undefined | null
    const width = source?.width ?? 0
    if (!width) return sourceId
    const twin = lodTextureId(sourceId, halveTo(width, level))
    return tm.getTexture(twin) ? twin : sourceId
}

/**
 * A library material reduced for LOD `level`: from level 2 on only {@link DISTANT_LOD_SLOTS} stay, and
 * every kept texture is swapped for its twin at that level ({@link lodTwinFor}). What a generated level
 * draws, re-derived from the CURRENT library material each time it is instantiated.
 */
export function lodLevelMaterial(serialized: any, level: number): any {
    const ids = new Map<string, string>()
    for (const id of levelTextureIds(serialized, level)) ids.set(id, lodTwinFor(id, level))
    return levelMaterialJson(serialized, ids, level)
}
