// What a project holds of the Creator library: one link per Creator asset, naming the editor assets the
// sync made from it and the revision they were made from. Pure, so the planning is tested on its own.
//
// Editor ids are DERIVED from the Creator id rather than minted, so syncing the same asset twice -- after
// a reload, in another project, after a lost link table -- lands on the same records instead of piling
// up copies.

import type { CreatorAssetKind, CreatorAssetMeta } from '@cleo/app-kit/creatorLibrary'
import { CREATOR_ROOT } from './creatorPins'

export interface CreatorLink {
  kind: CreatorAssetKind
  name: string
  /** The Creator revision these assets were made from. */
  revision: number
  /** The folder they are kept in (/Creator/<Kind>/<Name>). */
  folder: string
  modelId?: string
  particleSystemId?: string
  materialIds: string[]
  /** Every texture the sync registered for the asset (garbage-collected when a revision drops one). */
  textureIds: string[]
  /** The asset was deleted in the Creator while this project still used it: kept, marked removed. */
  removed?: true
}

export type CreatorLinks = Record<string, CreatorLink>

export interface CreatorSyncPlan {
  /** Assets to (re)build: new, or at a revision the project has not applied. */
  upsert: CreatorAssetMeta[]
  /** Creator ids whose asset is gone (deleted, or no longer in the library) and are still linked. */
  retire: string[]
}

/** What to do to bring a project's links up to the library. */
export function planCreatorSync(assets: readonly CreatorAssetMeta[], links: Readonly<CreatorLinks>): CreatorSyncPlan {
  const upsert: CreatorAssetMeta[] = []
  const retire: string[] = []
  const seen = new Set<string>()
  for (const a of assets) {
    seen.add(a.id)
    const link = links[a.id]
    if (a.deleted) {
      if (link && !link.removed) retire.push(a.id)
      continue
    }
    // An asset saved but not yet built has no files: nothing to make until its first publish.
    if (!a.fileNames.length) continue
    if (!link || link.removed || a.revision > link.revision) upsert.push(a)
  }
  for (const id of Object.keys(links)) if (!seen.has(id) && !links[id].removed) retire.push(id)
  return { upsert, retire }
}

const KIND_FOLDER: Record<CreatorAssetKind, string> = { foliage: 'Foliage', fx: 'FX', world: 'World' }

/** A name safe as one path segment. */
export function folderSafe(name: string): string {
  return name.replace(/[\\/]/g, '-').trim() || 'Untitled'
}

/** The folder a Creator asset's editor assets are kept in. */
export function creatorFolder(kind: CreatorAssetKind, name: string): string {
  return `${CREATOR_ROOT}/${KIND_FOLDER[kind]}/${folderSafe(name)}`
}

/** Where removed assets a project still uses are kept. */
export const REMOVED_FOLDER = `${CREATOR_ROOT}/Removed`

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'x'

export const creatorIds = {
  model: (cid: string) => `cr_${cid}`,
  particleSystem: (cid: string) => `cr_${cid}`,
  /** One material per mesh part ("Bark", "Leaves"), so a level that adds or drops a part cannot shift them. */
  material: (cid: string, part: string) => `cr_${cid}_${slug(part)}`,
  /** A texture the sync registers from a file of the asset: `fx_flipbook.png` -> `cr_<cid>_fx_flipbook`. */
  texture: (cid: string, fileName: string) => `cr_${cid}_${slug(fileName.replace(/\.[a-z0-9]+$/i, ''))}`,
}
