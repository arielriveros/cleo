import type { VfsIndex } from './vfs'
import type { ProjectMeta } from './sceneStorage'

export interface ProjectConfigV1 {
  version: 1
  vfs: VfsIndex
  project: ProjectMeta
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isVfsIndex(value: unknown): value is VfsIndex {
  return isObject(value)
    && value.version === 1
    && Array.isArray(value.folders)
    && Array.isArray(value.entries)
}

function isProjectMeta(value: unknown): value is ProjectMeta {
  return isObject(value)
    && value.version === 2
    && typeof value.mainSceneId === 'string'
    && typeof value.openSceneId === 'string'
    && Array.isArray(value.scenes)
}

export function buildProjectConfig(vfs: VfsIndex, project: ProjectMeta): ProjectConfigV1 {
  return { version: 1, vfs, project }
}

export function parseProjectConfig(value: unknown): ProjectConfigV1 | null {
  if (!isObject(value) || value.version !== 1) return null
  if (!isVfsIndex(value.vfs) || !isProjectMeta(value.project)) return null
  return { version: 1, vfs: value.vfs, project: value.project }
}
