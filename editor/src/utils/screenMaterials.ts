import { CameraNode, Material, CustomMaterial } from 'cleo'
import type { MaterialAsset } from './materials'

// Node variable that links a camera's ordered screen-space material passes to material assets
// (mirrors MATERIAL_ID_VAR, but holds an ORDERED LIST of asset ids as a JSON string — the node
// variable system has no array type).
export const SCREEN_MATERIAL_IDS_VAR = '__screenMaterialIds'

/** The ordered screen-material asset ids a camera references (empty when unset/corrupt). */
export function getScreenMaterialIds(node: CameraNode | null | undefined): string[] {
  const raw = node?.getVariable(SCREEN_MATERIAL_IDS_VAR)
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id: any) => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** Persist the ordered asset-id list on the camera node (removes the variable when empty). */
export function setScreenMaterialIds(node: CameraNode, ids: string[]): void {
  if (ids.length === 0) node.removeVariable(SCREEN_MATERIAL_IDS_VAR)
  else node.setVariable(SCREEN_MATERIAL_IDS_VAR, JSON.stringify(ids), 'string')
}

/**
 * Rebuild the camera's live screenMaterials from an ordered list of material assets (skipping any
 * that are not screen-mode custom materials) and stamp the id link variable. The materials are
 * serialized inline with the camera on save, so runtime scenes don't need the asset library.
 */
export function applyScreenMaterials(node: CameraNode, assets: MaterialAsset[]): void {
  const mats: CustomMaterial[] = []
  const ids: string[] = []
  for (const asset of assets) {
    const mat = Material.parse(asset.material)
    if (mat instanceof CustomMaterial && mat.renderMode === 'screen') {
      mats.push(mat)
      ids.push(asset.id)
    }
  }
  node.screenMaterials = mats
  setScreenMaterialIds(node, ids)
}

/** True when a serialized material (MaterialAsset.material) is a screen-mode custom material. */
export function isScreenMaterialAsset(asset: MaterialAsset): boolean {
  const m = asset.material
  return !!m && (m.customMaterial || (typeof m.type === 'string' && m.type.startsWith('customScreen:'))) && m.renderMode === 'screen'
}
