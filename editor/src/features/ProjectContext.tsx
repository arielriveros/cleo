import { createContext, useContext } from 'react';
import type { useCleoEngine } from './EngineContext';

type EngineValue = ReturnType<typeof useCleoEngine>;

/**
 * The multi-scene project slice: the scene list, which scene is open / is the main one, and the
 * scene-level operations — split out of the large EngineContext.
 *
 * Cohesive because it is all backed by one persisted record (the project meta at `cleo_project_meta`,
 * whose authoritative copy is `projectMetaRef`); the state here is the reactive mirror of it. The
 * unsaved-scene confirm dialog lives here too, since it gates switching the open scene.
 *
 * Derived via `Pick` so the signatures stay in lockstep with the context they are lifted from.
 */
export type ProjectContextValue = Pick<EngineValue,
  | 'sceneList' | 'mainSceneId' | 'openSceneId'
  | 'openScene' | 'createScene' | 'renameScene' | 'deleteScene' | 'duplicateScene' | 'setMainScene'
  | 'sceneDimension' | 'setSceneDimension'
  | 'pendingSceneConfirm' | 'resolveSceneConfirm'
  | 'replaceProjectMeta'
>;

export const ProjectContext = createContext<ProjectContextValue | null>(null);

/** Read the multi-scene project slice. Provided by EngineProvider. */
export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used within an EngineProvider');
  return ctx;
}
