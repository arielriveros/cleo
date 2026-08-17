import { TextureManager, CleoEngine } from 'cleo'
import type { MaterialAsset } from '../../utils/materials'
import type { TerrainMaterialAsset } from '../../utils/terrainMaterials'
import type { Template } from '../../utils/templates'
import type { ModelAsset } from '../../utils/models'
import type { ScriptAsset } from '../../utils/scripts'
import type { AnimationFieldAsset } from '../../utils/animationFields'
import type { TilesetAsset } from '../../utils/tilesets'
import type { SceneMeta } from '../../utils/sceneStorage'
import {
  renderMaterialAssetThumbnail, renderModelAssetThumbnail, renderTerrainMaterialAssetThumbnail,
} from '../../utils/modelThumbnails'
import { cryptoRandomId } from '../../utils/UIModel'
import { deleteTextures } from '../../utils/textureStore'
import { AssetKind, KIND_LABEL } from '../../utils/vfs'

// One adapter per asset kind, so the file-manager event bridge never has to branch five ways. Everything
// the explorer does to an asset — read its name/thumbnail, rename it, duplicate it, delete it, open its
// editor — goes through here.

export type AssetDeps = {
  materials: MaterialAsset[]
  terrainMaterials: TerrainMaterialAsset[]
  templates: Template[]
  models: ModelAsset[]
  scripts: ScriptAsset[]
  animationFields: AnimationFieldAsset[]
  tilesets: TilesetAsset[]
  scenes: SceneMeta[]

  addMaterial: (m: MaterialAsset) => void
  updateMaterial: (id: string, m: MaterialAsset) => void
  removeMaterial: (id: string) => void
  addTerrainMaterial: (m: TerrainMaterialAsset) => void
  updateTerrainMaterial: (id: string, m: TerrainMaterialAsset) => void
  removeTerrainMaterial: (id: string) => void
  addTemplate: (t: Template) => void
  updateTemplate: (id: string, t: Template) => void
  removeTemplate: (id: string) => void
  addModel: (m: ModelAsset) => void
  updateModel: (id: string, m: ModelAsset) => void
  removeModel: (id: string) => void
  addScriptAsset: (s: ScriptAsset) => void
  updateScriptAsset: (id: string, s: ScriptAsset) => void
  removeScriptAsset: (id: string) => void
  addAnimationField: (f: AnimationFieldAsset) => void
  updateAnimationField: (id: string, f: AnimationFieldAsset) => void
  removeAnimationField: (id: string) => void
  addTileset: (t: TilesetAsset) => void
  updateTileset: (id: string, t: TilesetAsset) => void
  removeTileset: (id: string) => void
  createScene: (name?: string) => Promise<string>
  renameScene: (sceneId: string, name: string) => void
  deleteScene: (sceneId: string) => Promise<string | null>
  duplicateScene: (sceneId: string) => Promise<string | null>
  openScene: (sceneId: string) => Promise<boolean>
  setMainScene: (sceneId: string) => void

  enterMaterialEditor: (id?: string) => void
  enterTerrainMaterialEditor: (id?: string) => void
  enterTemplateEditor: (id?: string) => void
  enterModelEditor: (id?: string) => void
  enterScriptEditor: (id?: string) => void
  enterAnimationFieldEditor: (id?: string) => void
  enterTilesetEditor: (id?: string) => void

  emit: (event: string, payload?: any) => void
}

type AnyAsset = MaterialAsset | TerrainMaterialAsset | Template | ModelAsset | ScriptAsset | AnimationFieldAsset | TilesetAsset | SceneMeta

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

/** The asset record behind an entry, or undefined. Textures have no record — they return undefined. */
export function findAsset(kind: AssetKind, id: string, deps: AssetDeps): AnyAsset | undefined {
  switch (kind) {
    case 'material': return deps.materials.find(m => m.id === id)
    case 'terrainMaterial': return deps.terrainMaterials.find(m => m.id === id)
    case 'template': return deps.templates.find(t => t.id === id)
    case 'model': return deps.models.find(m => m.id === id)
    case 'script': return deps.scripts.find(s => s.id === id)
    case 'animationField': return deps.animationFields.find(f => f.id === id)
    case 'tileset': return deps.tilesets.find(t => t.id === id)
    case 'scene': return deps.scenes.find(s => s.id === id)
    case 'texture': return undefined
  }
}

/** True when the asset still exists (a texture exists iff it is registered in the TextureManager). */
export function assetExists(kind: AssetKind, id: string, deps: AssetDeps): boolean {
  if (kind === 'texture') return !!TextureManager.Instance.getTexture(id)
  return !!findAsset(kind, id, deps)
}

/** A rough byte size, computed once when an asset is first indexed — never per render. */
export function sizeOfAsset(kind: AssetKind, id: string, deps: AssetDeps): number | undefined {
  if (kind === 'texture') {
    const data = TextureManager.Instance.getTexture(id)?.data as HTMLImageElement | undefined
    const src = data instanceof HTMLImageElement ? data.src : ''
    // A data: URL is base64, so ~3 bytes per 4 characters. A blob:/http: src tells us nothing.
    return src.startsWith('data:') ? Math.round(src.length * 0.75) : undefined
  }
  const asset = findAsset(kind, id, deps)
  if (!asset) return undefined
  try { return JSON.stringify(asset).length } catch { return undefined }
}

/** The preview image for a card: the asset's rendered thumbnail, or the texture's own image. */
export function thumbnailOf(kind: AssetKind, id: string, deps: AssetDeps): string | null {
  if (kind === 'texture') {
    const data = TextureManager.Instance.getTexture(id)?.data as HTMLImageElement | undefined
    return data instanceof HTMLImageElement && data.src ? data.src : null
  }
  // Templates have no thumbnail field at all; materials/terrain materials start with an empty one until
  // their first save. Both fall through to the kind's icon.
  const asset = findAsset(kind, id, deps) as { thumbnail?: string } | undefined
  return asset?.thumbnail || null
}

/**
 * Rename an asset to `stem` (the new basename without its extension).
 * Textures are deliberately exempt: a texture's id is its name, and that id is baked into every serialized
 * material that references it — renaming it would orphan them. The VFS path carries the display name instead.
 */
export function renameAsset(kind: AssetKind, id: string, stem: string, deps: AssetDeps): void {
  switch (kind) {
    case 'material': {
      const a = deps.materials.find(m => m.id === id)
      if (a) deps.updateMaterial(id, { ...a, name: stem })
      break
    }
    case 'terrainMaterial': {
      const a = deps.terrainMaterials.find(m => m.id === id)
      if (a) deps.updateTerrainMaterial(id, { ...a, name: stem })
      break
    }
    case 'template': {
      const a = deps.templates.find(t => t.id === id)
      if (a) deps.updateTemplate(id, { ...a, name: stem })
      break
    }
    case 'model': {
      const a = deps.models.find(m => m.id === id)
      if (a) deps.updateModel(id, { ...a, name: stem })
      break
    }
    case 'script': {
      const a = deps.scripts.find(s => s.id === id)
      if (a) deps.updateScriptAsset(id, { ...a, name: stem })
      break
    }
    case 'animationField': {
      const a = deps.animationFields.find(f => f.id === id)
      if (a) deps.updateAnimationField(id, { ...a, name: stem })
      break
    }
    case 'tileset': {
      const a = deps.tilesets.find(t => t.id === id)
      if (a) deps.updateTileset(id, { ...a, name: stem })
      break
    }
    case 'scene': {
      const a = deps.scenes.find(s => s.id === id)
      if (a) deps.renameScene(id, stem)
      break
    }
    case 'texture':
      break
  }
}

/** Delete an asset. Each library's remover already unlinks the nodes that referenced it. */
export function deleteAsset(kind: AssetKind, id: string, deps: AssetDeps): void {
  switch (kind) {
    case 'material': deps.removeMaterial(id); break
    case 'terrainMaterial': deps.removeTerrainMaterial(id); break
    case 'template': deps.removeTemplate(id); break
    case 'model': deps.removeModel(id); break
    case 'script': deps.removeScriptAsset(id); break
    case 'animationField': deps.removeAnimationField(id); break
    case 'tileset': deps.removeTileset(id); break
    case 'scene': {
      void deps.deleteScene(id)
      break
    }
    case 'texture':
      TextureManager.Instance.removeTexture(id)
      // Drop the payload too, or the texture store keeps it forever. Only done for an explicit texture
      // delete: deleting a material or mesh must NOT evict its maps, which are shared by id.
      void deleteTextures([id])
      deps.emit('TEXTURES_CHANGED')
      break
  }
}

/**
 * Deep-clone an asset under a new id and name. Returns the new asset id, or null if it couldn't be cloned.
 * A mesh's `materialIds` are intentionally NOT cloned — the copy shares the originals' material assets.
 */
export function duplicateAsset(kind: AssetKind, id: string, stem: string, deps: AssetDeps): string | null {
  const newId = cryptoRandomId()
  switch (kind) {
    case 'material': {
      const a = deps.materials.find(m => m.id === id)
      if (!a) return null
      deps.addMaterial({ ...deepClone(a), id: newId, name: stem })
      return newId
    }
    case 'terrainMaterial': {
      const a = deps.terrainMaterials.find(m => m.id === id)
      if (!a) return null
      deps.addTerrainMaterial({ ...deepClone(a), id: newId, name: stem })
      return newId
    }
    case 'template': {
      const a = deps.templates.find(t => t.id === id)
      if (!a) return null
      deps.addTemplate({ ...deepClone(a), id: newId, name: stem })
      return newId
    }
    case 'model': {
      const a = deps.models.find(m => m.id === id)
      if (!a) return null
      deps.addModel({ ...deepClone(a), id: newId, name: stem, materialIds: [...(a.materialIds ?? [])] })
      return newId
    }
    case 'script': {
      const a = deps.scripts.find(s => s.id === id)
      if (!a) return null
      deps.addScriptAsset({ ...deepClone(a), id: newId, name: stem })
      return newId
    }
    case 'animationField': {
      const a = deps.animationFields.find(f => f.id === id)
      if (!a) return null
      // modelId is deliberately carried over: a duplicated field blends the same character's clips.
      deps.addAnimationField({ ...deepClone(a), id: newId, name: stem })
      return newId
    }
    case 'tileset': {
      const a = deps.tilesets.find(t => t.id === id)
      if (!a) return null
      // textureId carries over: duplicating a tileset means re-slicing the same atlas, or keeping a
      // second variant of its per-tile metadata.
      deps.addTileset({ ...deepClone(a), id: newId, name: stem })
      return newId
    }
    case 'scene': {
      const a = deps.scenes.find(s => s.id === id)
      if (!a) return null
      return null
    }
    case 'texture': {
      const tm = TextureManager.Instance
      const source = tm.getTexture(id)
      if (!source) return null
      const data = tm.serializeTexture(id) // re-encodes the image to a PNG data URL
      if (!data) return null
      // Keep the pretty name as the TextureManager id when it is free — that id is what shows up inside
      // serialized materials — but never collide with an existing texture.
      const texId = tm.getTexture(stem) ? `${stem}-${newId.slice(0, 6)}` : stem
      tm.addTextureFromBase64(data, source.config, texId)
      deps.emit('TEXTURES_CHANGED')
      return texId
    }
  }
}

/**
 * Re-render an asset's thumbnail from its saved data and store it. Returns true if a new image was written.
 *
 * Only the kinds whose preview is *rendered* can be regenerated: a template has no thumbnail field, and a
 * texture's preview is the texture image itself — neither involves the renderer, so both are no-ops.
 */
export async function regenerateThumbnail(
  kind: AssetKind, id: string, engine: CleoEngine, deps: AssetDeps,
): Promise<boolean> {
  switch (kind) {
    case 'material': {
      const a = deps.materials.find(m => m.id === id)
      if (!a) return false
      const thumbnail = await renderMaterialAssetThumbnail(engine, a)
      if (!thumbnail) return false
      deps.updateMaterial(id, { ...a, thumbnail })
      return true
    }
    case 'terrainMaterial': {
      const a = deps.terrainMaterials.find(m => m.id === id)
      if (!a) return false
      const thumbnail = await renderTerrainMaterialAssetThumbnail(engine, a)
      if (!thumbnail) return false
      deps.updateTerrainMaterial(id, { ...a, thumbnail })
      return true
    }
    case 'model': {
      const a = deps.models.find(m => m.id === id)
      if (!a) return false
      const thumbnail = await renderModelAssetThumbnail(engine, a)
      if (!thumbnail) return false
      deps.updateModel(id, { ...a, thumbnail })
      return true
    }
    case 'scene':
      return false
    case 'template':
    case 'script':
    // A tileset's card shows its atlas image, produced by a canvas downscale on save rather than by
    // the 3D thumbnail renderer this function drives.
    case 'tileset':
    // A field's card shows its kind icon: its content is a 2D plot, not something the 3D thumbnail
    // renderer (which poses a model in a preview scene) has any way to draw.
    case 'animationField':
    case 'texture':
      return false
  }
}

/**
 * Open the asset's editor. Returns false for kinds that have no editor (textures).
 *
 * A mesh opens a read-only preview tab. That is deliberate: imports no longer render thumbnails (each one
 * cost a full GL frame and stalled the editor), so opening an asset is what renders its preview.
 */
export function openAsset(kind: AssetKind, id: string, deps: AssetDeps): boolean {
  switch (kind) {
    case 'material': deps.enterMaterialEditor(id); return true
    case 'terrainMaterial': deps.enterTerrainMaterialEditor(id); return true
    case 'template': deps.enterTemplateEditor(id); return true
    case 'model': deps.enterModelEditor(id); return true
    case 'script': deps.enterScriptEditor(id); return true
    case 'animationField': deps.enterAnimationFieldEditor(id); return true
    case 'tileset': deps.enterTilesetEditor(id); return true
    case 'scene': void deps.openScene(id); return true
    default: return false
  }
}

/** What deleting this asset does to the things still referencing it — shown in the confirm dialog. */
export function deleteConsequence(kind: AssetKind): string {
  switch (kind) {
    case 'material': return 'nodes using it fall back to a basic material'
    case 'terrainMaterial': return 'terrain layers painted with it are cleared'
    case 'template': return 'placed instances are unlinked and become normal nodes'
    case 'model': return 'placed copies stay in the scene'
    case 'script': return 'nodes using it lose their script and its variables'
    case 'animationField': return 'animation states playing it fall back to no clip'
    case 'tileset': return 'tilemap layers painted with it are cleared'
    case 'scene': return 'the project switches to another scene'
    case 'texture': return 'materials and tilesets using it show no texture'
  }
}

/** The DataTransfer entries a drag of this asset must carry, so every existing drop target keeps working. */
export function dragPayload(kind: AssetKind, assetId: string): [string, string][] {
  switch (kind) {
    case 'model': return [['text/cleo-model', assetId]]
    case 'template': return [['text/cleo-template', assetId]]
    case 'material': return [['text/cleo-material', assetId]]
    case 'terrainMaterial': return [['text/cleo-terrain-material', assetId]]
    case 'script': return [['text/cleo-script', assetId]]
    case 'animationField': return [['text/cleo-animation-field', assetId]]
    case 'tileset': return [['text/cleo-tileset', assetId]]
    case 'scene': return [['text/cleo-scene', assetId], ['text/plain', assetId]]
    case 'texture': return [
      ['text/cleo-asset', JSON.stringify({ type: 'texture', id: assetId })],
      ['text/plain', assetId], // TextureInspector's fallback
    ]
  }
}

/** Human-readable kind, for tooltips and dialogs. */
export function labelOf(kind: AssetKind): string {
  return KIND_LABEL[kind]
}

// ---------------------------------------------------------------------------------------------------
// Icons. Inlined as data URIs: the SVAR default hits its CDN for one SVG per card, which we never want.
// ---------------------------------------------------------------------------------------------------

// Line icons in the same stroke style as the chrome glyphs in filemanager.css, tinted per kind so a card
// without a thumbnail still reads at a glance.
function svg(stroke: string, body: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
  )}`
}

const ICONS: Record<AssetKind | 'folder', string> = {
  folder: svg('#8f8fff',
    `<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="#8f8fff" fill-opacity=".16"/>`,
  ),
  material: svg('#6f9fe8',
    `<circle cx="12" cy="12" r="8.5" fill="#326acc" fill-opacity=".2"/><path d="M7.5 9.5a5 5 0 0 1 4-2.9"/>`,
  ),
  terrainMaterial: svg('#5cbf5c',
    `<path d="M2 19 8.5 8l4 5.6L15 10l7 9z" fill="#2c7a2c" fill-opacity=".2"/>`,
  ),
  template: svg('#b08fef',
    `<rect x="4" y="4" width="16" height="16" rx="2.5" fill="#7a4fd4" fill-opacity=".18"/><path d="M8 10.5h8M8 14.5h5"/>`,
  ),
  model: svg('#4fc3d5',
    `<path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z" fill="#1f7f8f" fill-opacity=".18"/><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10"/>`,
  ),
  scene: svg('#f2b84b',
    `<path d="M4 19V5h16v14z" fill="#7f5a10" fill-opacity=".18"/><path d="M7 15l3-3 2 2 3-4 2 2"/>`,
  ),
  script: svg('#e0794b',
    `<rect x="4" y="3" width="16" height="18" rx="2" fill="#8f4a26" fill-opacity=".18"/><path d="M10 9 8 12l2 3M14 9l2 3-2 3"/>`,
  ),
  // A blend space: two axes with sample points scattered across them.
  animationField: svg('#d47ab8',
    `<rect x="3.5" y="3.5" width="17" height="17" rx="2" fill="#8f3a70" fill-opacity=".18"/><path d="M3.5 16.5h17M8 20.5v-17" stroke-opacity=".5"/><circle cx="8" cy="16.5" r="1.5"/><circle cx="13" cy="10" r="1.5"/><circle cx="18" cy="7" r="1.5"/>`,
  ),
  // A sliced atlas: the grid, with one cell picked out.
  tileset: svg('#7ec8a9',
    `<rect x="3.5" y="3.5" width="17" height="17" rx="2" fill="#2f7a63" fill-opacity=".2"/><path d="M9 3.5v17M14.5 3.5v17M3.5 9h17M3.5 14.5h17" stroke-opacity=".55"/><rect x="9" y="9" width="5.5" height="5.5" fill="#7ec8a9" fill-opacity=".45" stroke="none"/>`,
  ),
  texture: svg('#9aa4b2',
    `<rect x="3" y="4.5" width="18" height="15" rx="2" fill="#4a4a55" fill-opacity=".3"/><circle cx="8.5" cy="9.5" r="1.6" stroke="#ffd27a"/><path d="M4 17.5l5-5.5 3.5 4 3-2.5 4.5 4"/>`,
  ),
}

/** Icon URL for a file-manager entry, by kind (or 'folder'). */
export function iconFor(kind: AssetKind | 'folder'): string {
  return ICONS[kind]
}
